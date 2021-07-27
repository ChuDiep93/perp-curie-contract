import { MockContract } from "@eth-optimism/smock"
import { expect } from "chai"
import { parseUnits } from "ethers/lib/utils"
import { waffle } from "hardhat"
import { ClearingHouse, TestERC20, UniswapV3Pool, Vault } from "../../typechain"
import { toWei } from "../helper/number"
import { deposit } from "../helper/token"
import { encodePriceSqrt } from "../shared/utilities"
import { BaseQuoteOrdering, createClearingHouseFixture } from "./fixtures"

describe("ClearingHouse liquidate", () => {
    const [admin, alice, bob, carol] = waffle.provider.getWallets()
    const loadFixture: ReturnType<typeof waffle.createFixtureLoader> = waffle.createFixtureLoader([admin])
    const million = toWei(1000000)
    const hundred = toWei(100)
    const ten = toWei(10)
    let clearingHouse: ClearingHouse
    let vault: Vault
    let collateral: TestERC20
    let baseToken: TestERC20
    let quoteToken: TestERC20
    let pool: UniswapV3Pool
    let baseToken2: TestERC20
    let pool2: UniswapV3Pool
    let mockedBaseAggregator: MockContract

    beforeEach(async () => {
        const _clearingHouseFixture = await loadFixture(createClearingHouseFixture(BaseQuoteOrdering.BASE_0_QUOTE_1))
        clearingHouse = _clearingHouseFixture.clearingHouse
        vault = _clearingHouseFixture.vault
        collateral = _clearingHouseFixture.USDC
        baseToken = _clearingHouseFixture.baseToken
        quoteToken = _clearingHouseFixture.quoteToken
        pool = _clearingHouseFixture.pool
        baseToken2 = _clearingHouseFixture.baseToken2
        pool2 = _clearingHouseFixture.pool2
        mockedBaseAggregator = _clearingHouseFixture.mockedBaseAggregator

        // add pool
        await clearingHouse.addPool(baseToken.address, 10000)
        await clearingHouse.addPool(baseToken2.address, 10000)

        // mint
        collateral.mint(alice.address, hundred)
        collateral.mint(bob.address, million)
        collateral.mint(carol.address, million)

        await deposit(alice, vault, 10, collateral)
        await deposit(bob, vault, 1000000, collateral)
        await deposit(carol, vault, 1000000, collateral)

        mockedBaseAggregator.smocked.latestRoundData.will.return.with(async () => {
            return [0, parseUnits("100", 6), 0, 0, 0]
        })

        // mint base
        await clearingHouse.connect(carol).mint(baseToken.address, toWei("100"))
        await clearingHouse.connect(carol).mint(quoteToken.address, toWei("15000"))

        // initialize pool
        await pool.initialize(encodePriceSqrt("151.3733069", "1"))
        await clearingHouse.connect(carol).addLiquidity({
            baseToken: baseToken.address,
            base: toWei(100),
            quote: toWei(15000),
            lowerTick: 49000,
            upperTick: 51400,
        })
    })

    describe("adjustable parameter", () => {
        it.skip("setLiquidationDiscount")
        it("setLiquidationPenaltyRatio", async () => {
            await clearingHouse.setLiquidationPenaltyRatio(toWei("0.03"))
            expect(await clearingHouse.liquidationPenaltyRatio()).to.eq(toWei("0.03"))
        })
        it("force error, only admin", async () => {
            await expect(clearingHouse.connect(alice).setLiquidationPenaltyRatio(toWei("0.03"))).to.be.revertedWith(
                "Ownable: caller is not the owner",
            )
        })
    })

    describe("alice took long in ETH, price doesn't change", () => {
        it("force error, margin ratio is above the requirement", async () => {
            await clearingHouse.connect(alice).openPosition({
                // buy base
                baseToken: baseToken.address,
                isBaseToQuote: false,
                isExactInput: true,
                amount: toWei(90),
                sqrtPriceLimitX96: 0,
            })
            await expect(clearingHouse.connect(bob).liquidate(alice.address, baseToken.address)).to.be.revertedWith(
                "CH_EAV",
            )
        })
    })

    describe("alice took long in ETH, bob took short", () => {
        beforeEach(async () => {
            // alice long ETH
            await clearingHouse.connect(alice).openPosition({
                baseToken: baseToken.address,
                isBaseToQuote: false,
                isExactInput: true,
                amount: toWei("90"),
                sqrtPriceLimitX96: 0,
            })
            // price after Alice swap : 151.4780456375

            // bob short ETH
            await clearingHouse.connect(bob).openPosition({
                baseToken: baseToken.address,
                isBaseToQuote: true,
                isExactInput: true,
                amount: toWei("50"),
                sqrtPriceLimitX96: 0,
            })
            // price after bob swap : 143.0326798397
        })

        describe.skip("carol takeover the position", () => {
            it("swap carol's quote to alice's base in a discount (size * marketTWAP * liquidationDiscount)")
            it("close alice's position")
            it("force error, carol's quote balance is insufficient")
        })

        describe("carol liquidate alice's position", () => {
            it("forcedly close alice's base position", async () => {
                const carolQuoteBefore = await clearingHouse.getTokenInfo(carol.address, quoteToken.address)

                // position size: 0.588407511354640018
                // position value: 0.58840 * 143.0326798397 = 84.1044463388
                // pnl = 84.1044463388 - 90 = -5.838496813155959470
                // positionNotional: (0.58840 * 0.99) * ~142.935(avg. price) = 83.292171864291669129
                // account value: 10 + (-5.838496813155959470) = 4.161503186844040530
                // fee = 83.292171864291669129 * 0.025 = 2.0823043
                await expect(clearingHouse.connect(carol).liquidate(alice.address, baseToken.address))
                    .to.emit(clearingHouse, "PositionLiquidated")
                    .withArgs(
                        alice.address,
                        baseToken.address,
                        "83292171864291669129",
                        toWei("0.588407511354640018"),
                        "2082304296607291728",
                        carol.address,
                    )
                // account value = collateral + pnl = 10 + (83.29 - 2.08 -90) = 1.209
                // init margin requirement = 8.7901324323 (only quote debt)
                // free collateral = 1.20986756 - 8.79013 * 0.1 = 0.330854324452815142

                // 10 + 83.292171864291669129 - 2.0823043 - 90 = 1.20986756
                expect(await vault.getFreeCollateral(alice.address)).to.eq("330854324452815142")

                const carolQuoteAfter = await clearingHouse.getTokenInfo(carol.address, quoteToken.address)
                expect(carolQuoteAfter.available.sub(carolQuoteBefore.available)).to.eq("2082304296607291728")
            })
        })

        it.skip("transfer penalty (liquidationNotional * liquidationPenaltyRatio) to InsuranceFund after swap")

        describe("price goes down further, alice's price impact is too high if total close", () => {
            it.skip("liquidate alice's position partially by carol")
        })

        it("force error, can't liquidate herself", async () => {})
    })

    // TODO copy the sheet above and make another scenario for short
    describe("alice took short in ETH, bob took long", () => {
        beforeEach(async () => {
            // alice short ETH
            await clearingHouse.connect(alice).openPosition({
                baseToken: baseToken.address,
                isBaseToQuote: true,
                isExactInput: false,
                amount: toWei("90"),
                sqrtPriceLimitX96: 0,
            })
            // price after Alice swap : 151.2675469692

            // bob long ETH
            await clearingHouse.connect(bob).openPosition({
                baseToken: baseToken.address,
                isBaseToQuote: false,
                isExactInput: false,
                amount: toWei("50"),
                sqrtPriceLimitX96: 0,
            })
            // price after bob swap : 160.56123246
        })

        describe("carol liquidate alice's position", () => {
            describe.skip("carol takeover the position", () => {
                it("swap carol's base to alice's quote in a discount (size * marketTWAP * liquidationDiscount)")
                it("close alice's position")
                it("force error, carol's base balance is insufficient")
            })

            it("forcedly close alice's quote position", async () => {
                // console.log((await clearingHouse.buyingPower(alice.address)).toString())
                // console.log((await vault.getFreeCollateral(alice.address)).toString())
                // console.log((await clearingHouse.getTotalMarketPnl(alice.address)).toString())
                // console.log((await clearingHouse.getAccountValue(alice.address)).toString())
                // console.log((await clearingHouse.getPositionValue(alice.address, baseToken.address, 0)).toString())

                const carolQuoteBefore = await clearingHouse.getTokenInfo(carol.address, quoteToken.address)

                let quoteTokenInfo = await clearingHouse.getTokenInfo(alice.address, quoteToken.address)
                console.log(quoteTokenInfo.available.toString(), quoteTokenInfo.debt.toString())
                let baseTokenInfo = await clearingHouse.getTokenInfo(alice.address, baseToken.address)
                console.log(baseTokenInfo.available.toString(), baseTokenInfo.debt.toString())

                // position size: 0.588407511354640018
                // position value: 0.58840 * 143.0326798397 = 84.1044463388
                // pnl = 84.1044463388 - 90 = -5.838496813155959470
                // positionNotional: (0.58840 * 0.99) * ~142.935(avg. price) = 83.292171864291669129
                // account value: 10 + (-5.838496813155959470) = 4.161503186844040530
                // fee = 83.292171864291669129 * 0.025 = 2.0823043
                await expect(clearingHouse.connect(carol).liquidate(alice.address, baseToken.address)).to.emit(
                    clearingHouse,
                    "PositionLiquidated",
                )
                // .withArgs(
                //     alice.address,
                //     baseToken.address,
                //     "83292171864291669129",
                //     toWei("0.588407511354640018"),
                //     "2082304296607291728",
                //     carol.address,
                // )
                // account value = collateral + pnl = 10 + (83.29 - 2.08 -90) = 1.209
                // init margin requirement = 8.7901324323 (only quote debt)
                // free collateral = 1.20986756 - 8.79013 * 0.1 = 0.330854324452815142

                // 10 + 83.292171864291669129 - 2.0823043 - 90 = 1.20986756
                // expect(await vault.getFreeCollateral(alice.address)).to.eq("330854324452815142")

                // const carolQuoteAfter = await clearingHouse.getTokenInfo(carol.address, quoteToken.address)

                quoteTokenInfo = await clearingHouse.getTokenInfo(alice.address, quoteToken.address)
                console.log(quoteTokenInfo.available.toString(), quoteTokenInfo.debt.toString())
                baseTokenInfo = await clearingHouse.getTokenInfo(alice.address, baseToken.address)
                console.log(baseTokenInfo.available.toString(), baseTokenInfo.debt.toString())
                // expect(carolQuoteAfter.available.sub(carolQuoteBefore.available)).to.eq("2082304296607291728")
            })

            it.skip("transfer penalty (liquidationNotional * liquidationPenaltyRatio) to InsuranceFund before swap")
        })

        describe("price goes up further, alice's price impact is too high if total close", () => {
            it.skip("liquidate alice's position partially by carol")
        })

        it("force error, can't liquidate herself")
    })

    describe("alice took long in ETH and BTC, price go down", () => {
        it("liquidate alice's ETH by carol")
        it("liquidate alice's BTC by carol")
    })

    describe("alice took short in ETH and BTC, price go down", () => {
        it("liquidate alice's ETH by carol")
        it("liquidate alice's BTC by carol")
    })
})
