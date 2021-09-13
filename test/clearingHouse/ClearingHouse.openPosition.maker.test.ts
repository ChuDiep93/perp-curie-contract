import { MockContract } from "@eth-optimism/smock"
import { parseEther } from "@ethersproject/units"
import { expect } from "chai"
import { parseUnits } from "ethers/lib/utils"
import { ethers, waffle } from "hardhat"
import {
    BaseToken,
    Exchange,
    OrderBook,
    QuoteToken,
    TestClearingHouse,
    TestERC20,
    UniswapV3Pool,
    Vault,
} from "../../typechain"
import { getMaxTick, getMinTick } from "../helper/number"
import { deposit } from "../helper/token"
import { encodePriceSqrt } from "../shared/utilities"
import { BaseQuoteOrdering, createClearingHouseFixture } from "./fixtures"

describe("ClearingHouse maker close position", () => {
    const [admin, alice, bob, carol] = waffle.provider.getWallets()
    const loadFixture: ReturnType<typeof waffle.createFixtureLoader> = waffle.createFixtureLoader([admin])
    let clearingHouse: TestClearingHouse
    let exchange: Exchange
    let orderBook: OrderBook
    let vault: Vault
    let collateral: TestERC20
    let quoteToken: QuoteToken
    let baseToken: BaseToken
    let mockedBaseAggregator: MockContract
    let pool: UniswapV3Pool
    let baseToken2: BaseToken
    let mockedBaseAggregator2: MockContract
    let pool2: UniswapV3Pool
    let lowerTick: number
    let upperTick: number
    let collateralDecimals: number

    beforeEach(async () => {
        const _clearingHouseFixture = await loadFixture(createClearingHouseFixture(BaseQuoteOrdering.BASE_0_QUOTE_1))
        clearingHouse = _clearingHouseFixture.clearingHouse as TestClearingHouse
        orderBook = _clearingHouseFixture.orderBook
        exchange = _clearingHouseFixture.exchange
        vault = _clearingHouseFixture.vault
        collateral = _clearingHouseFixture.USDC
        quoteToken = _clearingHouseFixture.quoteToken
        baseToken = _clearingHouseFixture.baseToken
        mockedBaseAggregator = _clearingHouseFixture.mockedBaseAggregator
        pool = _clearingHouseFixture.pool
        baseToken2 = _clearingHouseFixture.baseToken2
        mockedBaseAggregator2 = _clearingHouseFixture.mockedBaseAggregator2
        pool2 = _clearingHouseFixture.pool2
        collateralDecimals = await collateral.decimals()

        mockedBaseAggregator.smocked.latestRoundData.will.return.with(async () => {
            return [0, parseUnits("10", 6), 0, 0, 0]
        })

        await pool.initialize(encodePriceSqrt("10", "1"))
        // the initial number of oracle can be recorded is 1; thus, have to expand it
        await pool.increaseObservationCardinalityNext((2 ^ 16) - 1)

        await exchange.addPool(baseToken.address, "10000")

        const tickSpacing = await pool.tickSpacing()
        lowerTick = getMinTick(tickSpacing)
        upperTick = getMaxTick(tickSpacing)

        // alice add v2 style liquidity
        await collateral.mint(alice.address, parseUnits("1000", collateralDecimals))
        await deposit(alice, vault, 1000, collateral)
        await clearingHouse.connect(alice).addLiquidity({
            baseToken: baseToken.address,
            base: parseEther("10"),
            quote: parseEther("100"),
            lowerTick,
            upperTick,
            minBase: 0,
            minQuote: 0,
            deadline: ethers.constants.MaxUint256,
        })

        // so do carol (to avoid liquidity is 0 when any of the maker remove 100% liquidity)
        await collateral.mint(carol.address, parseUnits("1000", collateralDecimals))
        await deposit(carol, vault, 1000, collateral)
        await clearingHouse.connect(carol).addLiquidity({
            baseToken: baseToken.address,
            base: parseEther("90"),
            quote: parseEther("900"),
            lowerTick,
            upperTick,
            minBase: 0,
            minQuote: 0,
            deadline: ethers.constants.MaxUint256,
        })
    })

    // https://docs.google.com/spreadsheets/d/1kjs6thR9hXP2CCgn9zDcQESV5sWWumWIsKjBKJJC7Oc/edit#gid=574020995
    it("bob long, maker remove and close", async () => {
        // bob long
        await collateral.mint(bob.address, parseUnits("250", collateralDecimals))
        await deposit(bob, vault, 250, collateral)
        await clearingHouse.connect(bob).openPosition({
            baseToken: baseToken.address,
            isBaseToQuote: false, // quote to base
            isExactInput: true,
            oppositeAmountBound: 0, // exact input (quote)
            amount: parseEther("250"),
            sqrtPriceLimitX96: 0,
            deadline: ethers.constants.MaxUint256,
            referralCode: ethers.constants.HashZero,
        })

        // maker remove liquidity position
        const order = await exchange.getOpenOrder(alice.address, baseToken.address, lowerTick, upperTick)
        const liquidity = order.liquidity
        await clearingHouse.connect(alice).removeLiquidity({
            baseToken: baseToken.address,
            lowerTick,
            upperTick,
            liquidity,
            minBase: 0,
            minQuote: 0,
            deadline: ethers.constants.MaxUint256,
        })

        // maker close position
        const posSize = await clearingHouse.getPositionSize(alice.address, baseToken.address)
        await clearingHouse.connect(alice).openPosition({
            baseToken: baseToken.address,
            isBaseToQuote: false, // quote to base
            isExactInput: false,
            oppositeAmountBound: ethers.constants.MaxUint256, // exact output (base)
            amount: posSize.abs().toString(),
            sqrtPriceLimitX96: 0,
            deadline: ethers.constants.MaxUint256,
            referralCode: ethers.constants.HashZero,
        })

        // available + earned fee - debt = (124.75 - 31.75 - 0.32) + (2.5 * 10%) - 100 = -7.07
        expect(await clearingHouse.getOwedRealizedPnl(alice.address)).to.closeTo(parseEther("-7.069408740359897192"), 1)
    })

    it("bob long, maker remove, reduce half then close", async () => {
        // bob long
        await collateral.mint(bob.address, parseUnits("250", collateralDecimals))
        await deposit(bob, vault, 250, collateral)
        await clearingHouse.connect(bob).openPosition({
            baseToken: baseToken.address,
            isBaseToQuote: false, // quote to base
            isExactInput: true,
            oppositeAmountBound: 0, // exact input (quote)
            amount: parseEther("250"),
            sqrtPriceLimitX96: 0,
            deadline: ethers.constants.MaxUint256,
            referralCode: ethers.constants.HashZero,
        })

        // maker remove liquidity position
        const order = await exchange.getOpenOrder(alice.address, baseToken.address, lowerTick, upperTick)
        const liquidity = order.liquidity
        await clearingHouse.connect(alice).removeLiquidity({
            baseToken: baseToken.address,
            lowerTick,
            upperTick,
            liquidity: liquidity,
            minBase: 0,
            minQuote: 0,
            deadline: ethers.constants.MaxUint256,
        })

        {
            // maker reduce half position
            const posSize = await clearingHouse.getPositionSize(alice.address, baseToken.address)
            await clearingHouse.connect(alice).openPosition({
                baseToken: baseToken.address,
                isBaseToQuote: false, // quote to base
                isExactInput: false,
                oppositeAmountBound: ethers.constants.MaxUint256, // exact output (base)
                amount: posSize.div(2).abs().toString(),
                sqrtPriceLimitX96: 0,
                deadline: ethers.constants.MaxUint256,
                referralCode: ethers.constants.HashZero,
            })

            // include pnl, collectedFee and fundingPayment
            expect(await clearingHouse.getOwedRealizedPnl(alice.address)).to.closeTo(
                parseEther("-3.186153358681875804"),
                1,
            )
        }

        // maker close the remain half position, the pnl should be the same
        const posSize = await clearingHouse.getPositionSize(alice.address, baseToken.address)
        await clearingHouse.connect(alice).openPosition({
            baseToken: baseToken.address,
            isBaseToQuote: false, // quote to base
            isExactInput: false,
            oppositeAmountBound: ethers.constants.MaxUint256, // exact output (base)
            amount: posSize.abs().toString(),
            sqrtPriceLimitX96: 0,
            deadline: ethers.constants.MaxUint256,
            referralCode: ethers.constants.HashZero,
        })
        expect(await clearingHouse.getOwedRealizedPnl(alice.address)).closeTo(parseEther("-7.069408740359897191"), 3)
    })

    it("bob short, maker close", async () => {
        // bob long
        await collateral.mint(bob.address, parseUnits("250", collateralDecimals))
        await deposit(bob, vault, 250, collateral)
        await clearingHouse.connect(bob).openPosition({
            baseToken: baseToken.address,
            isBaseToQuote: true,
            isExactInput: true,
            oppositeAmountBound: 0,
            amount: parseEther("25"),
            sqrtPriceLimitX96: 0,
            deadline: ethers.constants.MaxUint256,
            referralCode: ethers.constants.HashZero,
        })

        // maker remove liquidity position
        const order = await exchange.getOpenOrder(alice.address, baseToken.address, lowerTick, upperTick)
        const liquidity = order.liquidity
        await clearingHouse.connect(alice).removeLiquidity({
            baseToken: baseToken.address,
            lowerTick,
            upperTick,
            liquidity,
            minBase: 0,
            minQuote: 0,
            deadline: ethers.constants.MaxUint256,
        })

        // maker close position
        const posSize = await clearingHouse.getPositionSize(alice.address, baseToken.address)
        await clearingHouse.connect(alice).openPosition({
            baseToken: baseToken.address,
            isBaseToQuote: true, // quote to base
            isExactInput: true,
            oppositeAmountBound: 0, // exact output (base)
            amount: posSize.abs().toString(),
            sqrtPriceLimitX96: 0,
            deadline: ethers.constants.MaxUint256,
            referralCode: ethers.constants.HashZero,
        })

        // available + earned fee - debt = (80 - -15.65 - 0.16) + (2 * 10%) - 100 = -4.3043478260869
        expect(await clearingHouse.getOwedRealizedPnl(alice.address)).deep.eq(parseEther("-4.304347826086956531"))
    })

    describe("maker for more than 1 market", () => {
        beforeEach(async () => {
            // init BTC pool
            mockedBaseAggregator2.smocked.latestRoundData.will.return.with(async () => {
                return [0, parseUnits("10", 6), 0, 0, 0]
            })
            await pool2.initialize(encodePriceSqrt("10", "1"))
            // the initial number of oracle can be recorded is 1; thus, have to expand it
            await pool2.increaseObservationCardinalityNext((2 ^ 16) - 1)

            await exchange.addPool(baseToken2.address, "10000")

            // alice add liquidity to BTC
            await collateral.mint(alice.address, parseUnits("1000", collateralDecimals))
            await deposit(alice, vault, 1000, collateral)
            await clearingHouse.connect(alice).addLiquidity({
                baseToken: baseToken2.address,
                base: parseEther("10"),
                quote: parseEther("100"),
                lowerTick,
                upperTick,
                minBase: 0,
                minQuote: 0,
                deadline: ethers.constants.MaxUint256,
            })

            // so do carol (to avoid liquidity is 0 when any of the maker remove 100% liquidity)
            await collateral.mint(carol.address, parseUnits("1000", collateralDecimals))
            await deposit(carol, vault, 1000, collateral)
            await clearingHouse.connect(carol).addLiquidity({
                baseToken: baseToken2.address,
                base: parseEther("90"),
                quote: parseEther("900"),
                lowerTick,
                upperTick,
                minBase: 0,
                minQuote: 0,
                deadline: ethers.constants.MaxUint256,
            })
        })

        it("bob long, maker remove and close", async () => {
            // bob long
            await collateral.mint(bob.address, parseUnits("250", collateralDecimals))
            await deposit(bob, vault, 250, collateral)
            await clearingHouse.connect(bob).openPosition({
                baseToken: baseToken.address,
                isBaseToQuote: false, // quote to base
                isExactInput: true,
                oppositeAmountBound: 0, // exact input (quote)
                amount: parseEther("250"),
                sqrtPriceLimitX96: 0,
                deadline: ethers.constants.MaxUint256,
                referralCode: ethers.constants.HashZero,
            })

            // maker remove liquidity position
            const order = await exchange.getOpenOrder(alice.address, baseToken.address, lowerTick, upperTick)
            const liquidity = order.liquidity
            await clearingHouse.connect(alice).removeLiquidity({
                baseToken: baseToken.address,
                lowerTick,
                upperTick,
                liquidity,
                minBase: 0,
                minQuote: 0,
                deadline: ethers.constants.MaxUint256,
            })

            // maker close position
            const posSize = await clearingHouse.getPositionSize(alice.address, baseToken.address)
            await clearingHouse.connect(alice).openPosition({
                baseToken: baseToken.address,
                isBaseToQuote: false, // quote to base
                isExactInput: false,
                oppositeAmountBound: ethers.constants.MaxUint256, // exact output (base)
                amount: posSize.abs().toString(),
                sqrtPriceLimitX96: 0,
                deadline: ethers.constants.MaxUint256,
                referralCode: ethers.constants.HashZero,
            })

            // should be same as the situation when adding liquidity in 1 pool
            expect(await clearingHouse.getOwedRealizedPnl(alice.address)).to.closeTo(
                parseEther("-7.069408740359897192"),
                1,
            )
        })

        it("bob short, maker close", async () => {
            // bob long
            await collateral.mint(bob.address, parseUnits("250", collateralDecimals))
            await deposit(bob, vault, 250, collateral)
            await clearingHouse.connect(bob).openPosition({
                baseToken: baseToken.address,
                isBaseToQuote: true,
                isExactInput: true,
                oppositeAmountBound: 0,
                amount: parseEther("25"),
                sqrtPriceLimitX96: 0,
                deadline: ethers.constants.MaxUint256,
                referralCode: ethers.constants.HashZero,
            })

            // maker remove liquidity position
            const order = await exchange.getOpenOrder(alice.address, baseToken.address, lowerTick, upperTick)
            const liquidity = order.liquidity
            await clearingHouse.connect(alice).removeLiquidity({
                baseToken: baseToken.address,
                lowerTick,
                upperTick,
                liquidity,
                minBase: 0,
                minQuote: 0,
                deadline: ethers.constants.MaxUint256,
            })

            // maker close position
            const posSize = await clearingHouse.getPositionSize(alice.address, baseToken.address)
            await clearingHouse.connect(alice).openPosition({
                baseToken: baseToken.address,
                isBaseToQuote: true, // quote to base
                isExactInput: true,
                oppositeAmountBound: 0, // exact output (base)
                amount: posSize.abs().toString(),
                sqrtPriceLimitX96: 0,
                deadline: ethers.constants.MaxUint256,
                referralCode: ethers.constants.HashZero,
            })

            // should be same as the situation when adding liquidity in 1 pool
            expect(await clearingHouse.getOwedRealizedPnl(alice.address)).deep.eq(parseEther("-4.304347826086956531"))
        })
    })
})
