import { MockContract } from "@eth-optimism/smock"
import { expect } from "chai"
import { parseEther, parseUnits } from "ethers/lib/utils"
import { ethers, waffle } from "hardhat"
import { ClearingHouse, TestERC20, UniswapV3Pool, Vault, VirtualToken } from "../../typechain"
import { getMaxTick, getMinTick } from "../helper/number"
import { deposit } from "../helper/token"
import { forwardBlock } from "../shared/time"
import { encodePriceSqrt } from "../shared/utilities"
import { BaseQuoteOrdering, createClearingHouseFixture } from "./fixtures"

describe("ClearingHouse partial close in xyk pool", () => {
    const [admin, maker, alice, carol, liquidator] = waffle.provider.getWallets()
    const loadFixture: ReturnType<typeof waffle.createFixtureLoader> = waffle.createFixtureLoader([admin])
    let clearingHouse: ClearingHouse
    let vault: Vault
    let collateral: TestERC20
    let baseToken: VirtualToken
    let quoteToken: VirtualToken
    let pool: UniswapV3Pool
    let mockedArbSys: MockContract
    let mockedBaseAggregator: MockContract
    let collateralDecimals: number
    let lowerTick: number
    let upperTick: number

    beforeEach(async () => {
        const _clearingHouseFixture = await loadFixture(createClearingHouseFixture(BaseQuoteOrdering.BASE_0_QUOTE_1))
        clearingHouse = _clearingHouseFixture.clearingHouse
        vault = _clearingHouseFixture.vault
        collateral = _clearingHouseFixture.USDC
        baseToken = _clearingHouseFixture.baseToken
        quoteToken = _clearingHouseFixture.quoteToken
        mockedBaseAggregator = _clearingHouseFixture.mockedBaseAggregator
        pool = _clearingHouseFixture.pool
        collateralDecimals = await collateral.decimals()
        mockedArbSys = _clearingHouseFixture.mockedArbSys

        mockedBaseAggregator.smocked.latestRoundData.will.return.with(async () => {
            return [0, parseUnits("10", 6), 0, 0, 0]
        })
        await pool.initialize(encodePriceSqrt("10", "1"))
        await clearingHouse.addPool(baseToken.address, "10000")

        const tickSpacing = await pool.tickSpacing()
        lowerTick = getMinTick(tickSpacing)
        upperTick = getMaxTick(tickSpacing)

        // prepare collateral for maker
        const makerCollateralAmount = parseUnits("1000", collateralDecimals)
        await collateral.mint(maker.address, makerCollateralAmount)
        await deposit(maker, vault, 1000, collateral)

        // maker add liquidity
        await clearingHouse.connect(maker).mint(baseToken.address, parseEther("100"))
        await clearingHouse.connect(maker).mint(quoteToken.address, parseEther("1000"))
        await clearingHouse.connect(maker).addLiquidity({
            baseToken: baseToken.address,
            base: parseEther("100"),
            quote: parseEther("1000"),
            lowerTick,
            upperTick,
            minBase: 0,
            minQuote: 0,
            deadline: ethers.constants.MaxUint256,
        })

        // prepare collateral for alice
        const aliceCollateral = parseUnits("1000", collateralDecimals)
        await collateral.mint(alice.address, aliceCollateral)
        await collateral.connect(alice).approve(clearingHouse.address, aliceCollateral)
        await deposit(alice, vault, 1000, collateral)

        // prepare collateral for carol
        const carolCollateral = parseUnits("1000", collateralDecimals)
        await collateral.mint(carol.address, carolCollateral)
        await collateral.connect(carol).approve(clearingHouse.address, carolCollateral)
        await deposit(carol, vault, 1000, collateral)

        // price delta for every tick is 0.01%
        // if we want to limit price impact to 1%, and 1% / 0.01% = 100
        // so limiting price impact to 1% means tick should not cross 100 ticks
        await clearingHouse.connect(admin).setMaxTickCrossedWithinBlock(baseToken.address, 100)
        await clearingHouse.connect(admin).setPartialCloseRatio(parseEther("0.25"))
    })

    // https://docs.google.com/spreadsheets/d/1cVd-sM9HCeEczgmyGtdm1DH3vyoYEN7ArKfXx7DztEk/edit#gid=577678159
    describe("partial close", () => {
        beforeEach(async () => {
            // carol first shorts 25 eth
            await clearingHouse.connect(carol).openPosition({
                baseToken: baseToken.address,
                isBaseToQuote: true,
                isExactInput: true,
                amount: parseEther("25"),
                sqrtPriceLimitX96: 0,
            })

            expect(await clearingHouse.getPositionSize(carol.address, baseToken.address)).eq(parseEther("-25"))

            // move to next block to simplify test case
            // otherwise we need to bring another trader to move the price further away
            await forwardBlock(mockedArbSys)
        })

        it("carol would be partially closed using closePosition", async () => {
            mockedBaseAggregator.smocked.latestRoundData.will.return.with(async () => {
                return [0, parseUnits("10000000", 6), 0, 0, 0]
            })

            // remaining position size = -25 - (-25 * 1/4) = -18.75
            await clearingHouse.connect(carol).closePosition(baseToken.address, 0)
            expect(await clearingHouse.getPositionSize(carol.address, baseToken.address)).eq(parseEther("-18.75"))
        })

        it("carol cannot open reverse position, is over price limit", async () => {
            // carol longs 25 eth
            await expect(
                clearingHouse.connect(carol).openPosition({
                    baseToken: baseToken.address,
                    isBaseToQuote: false,
                    isExactInput: false,
                    amount: parseEther("25"),
                    sqrtPriceLimitX96: 0,
                }),
            ).to.revertedWith("CH_OPI")
        })

        it("carol can reduce position, is not over price limit", async () => {
            // carol longs 0.1 eth
            await clearingHouse.connect(carol).openPosition({
                baseToken: baseToken.address,
                isBaseToQuote: false,
                isExactInput: false,
                amount: parseEther("0.1"),
                sqrtPriceLimitX96: 0,
            })
            expect(await clearingHouse.getPositionSize(carol.address, baseToken.address)).eq(parseEther("-24.9"))
        })
    })

    // https://docs.google.com/spreadsheets/d/1cVd-sM9HCeEczgmyGtdm1DH3vyoYEN7ArKfXx7DztEk/edit#gid=577678159
    describe("partial liquidate", () => {
        beforeEach(async () => {
            // carol first shorts 25 eth
            await clearingHouse.connect(carol).openPosition({
                baseToken: baseToken.address,
                isBaseToQuote: true,
                isExactInput: true,
                amount: parseEther("25"),
                sqrtPriceLimitX96: 0,
            })
            expect(await clearingHouse.getPositionSize(carol.address, baseToken.address)).eq(parseEther("-25"))

            // liquidation can't happen in the same block becuase it's based on the index price
            await forwardBlock(mockedArbSys)
        })

        it("taker should be partially liquidated", async () => {
            mockedBaseAggregator.smocked.latestRoundData.will.return.with(async () => {
                return [0, parseUnits("10000000", 6), 0, 0, 0]
            })

            // should be partially liquidated
            // remaining position size = -25 - (-25 * 1/4) = -18.75
            await clearingHouse.connect(liquidator).liquidate(carol.address, baseToken.address)
            expect(await clearingHouse.getPositionSize(carol.address, baseToken.address)).eq(parseEther("-18.75"))
        })
    })
})