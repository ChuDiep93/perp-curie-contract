import { MockContract } from "@eth-optimism/smock"
import { expect } from "chai"
import { parseEther, parseUnits } from "ethers/lib/utils"
import { ethers, waffle } from "hardhat"
import { Exchange, TestClearingHouse, TestERC20, UniswapV3Pool, Vault, VirtualToken } from "../../typechain"
import { deposit } from "../helper/token"
import { encodePriceSqrt } from "../shared/utilities"
import { BaseQuoteOrdering, createClearingHouseFixture } from "./fixtures"

describe("ClearingHouse openPosition", () => {
    const [admin, maker, taker, carol] = waffle.provider.getWallets()
    const loadFixture: ReturnType<typeof waffle.createFixtureLoader> = waffle.createFixtureLoader([admin])
    let clearingHouse: TestClearingHouse
    let exchange: Exchange
    let vault: Vault
    let collateral: TestERC20
    let baseToken: VirtualToken
    let baseToken2: VirtualToken
    let quoteToken: VirtualToken
    let pool: UniswapV3Pool
    let pool2: UniswapV3Pool
    let mockedBaseAggregator: MockContract
    let collateralDecimals: number
    const lowerTick: number = 0
    const upperTick: number = 100000

    beforeEach(async () => {
        const _clearingHouseFixture = await loadFixture(createClearingHouseFixture(BaseQuoteOrdering.BASE_0_QUOTE_1))
        clearingHouse = _clearingHouseFixture.clearingHouse as TestClearingHouse
        vault = _clearingHouseFixture.vault
        exchange = _clearingHouseFixture.exchange
        collateral = _clearingHouseFixture.USDC
        baseToken = _clearingHouseFixture.baseToken
        baseToken2 = _clearingHouseFixture.baseToken2
        quoteToken = _clearingHouseFixture.quoteToken
        mockedBaseAggregator = _clearingHouseFixture.mockedBaseAggregator
        pool = _clearingHouseFixture.pool
        pool2 = _clearingHouseFixture.pool2
        collateralDecimals = await collateral.decimals()

        mockedBaseAggregator.smocked.latestRoundData.will.return.with(async () => {
            return [0, parseUnits("100", 6), 0, 0, 0]
        })

        await pool.initialize(encodePriceSqrt("151.373306858723226652", "1")) // tick = 50200 (1.0001^50200 = 151.373306858723226652)
        // the initial number of oracle can be recorded is 1; thus, have to expand it
        await pool.increaseObservationCardinalityNext((2 ^ 16) - 1)

        await pool2.initialize(encodePriceSqrt("151.373306858723226652", "1")) // tick = 50200 (1.0001^50200 = 151.373306858723226652)
        // add pool after it's initialized
        await exchange.addPool(baseToken.address, 10000)
        await exchange.addPool(baseToken2.address, 10000)

        // prepare collateral for maker
        const makerCollateralAmount = parseUnits("1000000", collateralDecimals)
        await collateral.mint(maker.address, makerCollateralAmount)
        await deposit(maker, vault, 1000000, collateral)

        // maker add liquidity
        await clearingHouse.connect(maker).mint(baseToken.address, parseEther("65.943787")) // should only mint exact amount
        await clearingHouse.connect(maker).mint(quoteToken.address, parseEther("10000"))
        await clearingHouse.connect(maker).addLiquidity({
            baseToken: baseToken.address,
            base: parseEther("65.943787"),
            quote: parseEther("10000"),
            lowerTick,
            upperTick,
            minBase: 0,
            minQuote: 0,
            deadline: ethers.constants.MaxUint256,
        })

        // maker
        //   pool.base = 65.9437860798
        //   pool.quote = 10000
        //   liquidity = 884.6906588359
        //   virtual base liquidity = 884.6906588359 / sqrt(151.373306858723226652) = 71.9062751863
        //   virtual quote liquidity = 884.6906588359 * sqrt(151.373306858723226652) = 10884.6906588362

        // prepare collateral for taker
        const takerCollateral = parseUnits("1000", collateralDecimals)
        await collateral.mint(taker.address, takerCollateral)
        await collateral.connect(taker).approve(clearingHouse.address, takerCollateral)
    })

    describe("invalid input", () => {
        describe("taker has enough collateral", () => {
            beforeEach(async () => {
                await deposit(taker, vault, 1000, collateral)
            })

            it("force error due to invalid baseToken", async () => {
                await expect(
                    clearingHouse.connect(taker).openPosition({
                        baseToken: pool.address,
                        isBaseToQuote: true,
                        isExactInput: true,
                        amount: 1,
                        sqrtPriceLimitX96: 0,
                    }),
                ).to.be.revertedWith("CH_BTNE")
            })

            it("force error due to invalid amount (0)", async () => {
                await expect(
                    clearingHouse.connect(taker).openPosition({
                        baseToken: baseToken.address,
                        isBaseToQuote: true,
                        isExactInput: true,
                        amount: 0,
                        sqrtPriceLimitX96: 0,
                    }),
                ).to.be.revertedWith("UB_ZI")
            })

            it("force error due to slippage protection", async () => {
                // taker want to get 1 vETH in exact current price which is not possible
                await expect(
                    clearingHouse.connect(taker).openPosition({
                        baseToken: baseToken.address,
                        isBaseToQuote: false,
                        isExactInput: false,
                        amount: 1,
                        sqrtPriceLimitX96: encodePriceSqrt("151.373306858723226652", "1"),
                    }),
                ).to.be.revertedWith("SPL")
            })

            it("force error due to not enough liquidity", async () => {
                // empty the liquidity
                const order = await clearingHouse.getOpenOrder(maker.address, baseToken.address, lowerTick, upperTick)
                await clearingHouse.connect(maker).removeLiquidity({
                    baseToken: baseToken.address,
                    lowerTick,
                    upperTick,
                    liquidity: order.liquidity,
                    minBase: 0,
                    minQuote: 0,
                    deadline: ethers.constants.MaxUint256,
                })

                // trade
                await expect(
                    clearingHouse.connect(taker).openPosition({
                        baseToken: baseToken.address,
                        isBaseToQuote: false,
                        isExactInput: false,
                        amount: 1,
                        sqrtPriceLimitX96: 0,
                    }),
                ).to.be.revertedWith("CH_F0S")
            })
        })

        describe.only("taker has 0 collateral", () => {
            describe("market price lesser than index price", () => {
                beforeEach(async () => {
                    mockedBaseAggregator.smocked.latestRoundData.will.return.with(async () => {
                        return [0, parseUnits("185", 6), 0, 0, 0]
                    })
                })
                it("force error, Q2B, due to not enough collateral for mint", async () => {
                    await expect(
                        clearingHouse.connect(taker).openPosition({
                            baseToken: baseToken.address,
                            isBaseToQuote: false,
                            isExactInput: true,
                            amount: parseEther("500"),
                            sqrtPriceLimitX96: 0,
                        }),
                    ).to.be.revertedWith("CH_NEAV")
                })

                it("force error, B2Q, due to not enough collateral for mint", async () => {
                    await expect(
                        clearingHouse.connect(taker).openPosition({
                            baseToken: baseToken.address,
                            isBaseToQuote: true,
                            isExactInput: false,
                            amount: parseEther("500"),
                            sqrtPriceLimitX96: 0,
                        }),
                    ).to.be.revertedWith("CH_NEAV")
                })

                it("force error, Q2B, deposit small amount (1 wei)", async () => {
                    await collateral.connect(taker).approve(vault.address, 1)
                    await vault.connect(taker).deposit(collateral.address, 1)
                    await expect(
                        clearingHouse.connect(taker).openPosition({
                            baseToken: baseToken.address,
                            isBaseToQuote: false,
                            isExactInput: true,
                            amount: parseEther("1"),
                            sqrtPriceLimitX96: 0,
                        }),
                    ).to.be.revertedWith("CH_NEAV")
                })
                it("force error, B2Q, deposit small amount (1 wei)", async () => {
                    await collateral.connect(taker).approve(vault.address, 1)
                    await vault.connect(taker).deposit(collateral.address, 1)
                    await expect(
                        clearingHouse.connect(taker).openPosition({
                            baseToken: baseToken.address,
                            isBaseToQuote: true,
                            isExactInput: false,
                            amount: parseEther("1"),
                            sqrtPriceLimitX96: 0,
                        }),
                    ).to.be.revertedWith("CH_NEAV")
                })

                it.only("test available quote token amount in long", async () => {
                    // set fee ratio to 0
                    await clearingHouse.setFeeRatio(baseToken.address, 0)

                    mockedBaseAggregator.smocked.latestRoundData.will.return.with(async () => {
                        return [0, parseUnits("169", 6), 0, 0, 0]
                    })

                    const result = await clearingHouse
                        .connect(maker)
                        .getOpenOrder(maker.address, baseToken.address, lowerTick, upperTick)
                    console.log("liquidity: ", result.liquidity.toString()) // liquidity is 884690658835870366575

                    // using formula in https://www.notion.so/perp/Index-price-spread-attack-2f203d45b34f4cc3ab80ac835247030f#d3d12da52d4c455999dcca491a1ba34d
                    const calcQuoteAmount = (marketPrice: number, indexPrice: number, liquidity: number): number => {
                        return (
                            (indexPrice * liquidity * 0.9 - marketPrice * liquidity) / Math.sqrt(marketPrice) / 10 ** 18
                        )
                    }

                    // market price = 151.373306858723226652
                    // index price = 169
                    // liquidity = 884690658835870366575
                    console.log(
                        "quote amount(open long position without collateral): ",
                        calcQuoteAmount(151.373306858723226652, 169, 884690658835870366575),
                    )

                    // can open a long position without collateral with quote token amount 52.25
                    await clearingHouse.connect(taker).openPosition({
                        baseToken: baseToken.address,
                        isBaseToQuote: false,
                        isExactInput: true,
                        amount: parseEther("52.25"),
                        sqrtPriceLimitX96: 0,
                    })

                    // if quote token amount increased, open position failed
                    await expect(
                        clearingHouse.connect(taker).openPosition({
                            baseToken: baseToken.address,
                            isBaseToQuote: false,
                            isExactInput: true,
                            amount: parseEther("52.35"),
                            sqrtPriceLimitX96: 0,
                        }),
                    ).to.be.revertedWith("CH_NEAV")
                })
            })

            describe("market price greater than index price", () => {
                beforeEach(async () => {
                    mockedBaseAggregator.smocked.latestRoundData.will.return.with(async () => {
                        return [0, parseUnits("125", 6), 0, 0, 0]
                    })
                })
                it("force error, Q2B, due to not enough collateral for mint", async () => {
                    await expect(
                        clearingHouse.connect(taker).openPosition({
                            baseToken: baseToken.address,
                            isBaseToQuote: false,
                            isExactInput: true,
                            amount: parseEther("500"),
                            sqrtPriceLimitX96: 0,
                        }),
                    ).to.be.revertedWith("CH_NEAV")
                })

                it("force error, B2Q, due to not enough collateral for mint", async () => {
                    await expect(
                        clearingHouse.connect(taker).openPosition({
                            baseToken: baseToken.address,
                            isBaseToQuote: true,
                            isExactInput: false,
                            amount: parseEther("500"),
                            sqrtPriceLimitX96: 0,
                        }),
                    ).to.be.revertedWith("CH_NEAV")
                })

                it("force error, Q2B, deposit small amount (1 wei)", async () => {
                    await collateral.connect(taker).approve(vault.address, 1)
                    await vault.connect(taker).deposit(collateral.address, 1)
                    await expect(
                        clearingHouse.connect(taker).openPosition({
                            baseToken: baseToken.address,
                            isBaseToQuote: false,
                            isExactInput: true,
                            amount: parseEther("1"),
                            sqrtPriceLimitX96: 0,
                        }),
                    ).to.be.revertedWith("CH_NEAV")
                })
                it("force error, B2Q, deposit small amount (1 wei)", async () => {
                    await collateral.connect(taker).approve(vault.address, 1)
                    await vault.connect(taker).deposit(collateral.address, 1)
                    await expect(
                        clearingHouse.connect(taker).openPosition({
                            baseToken: baseToken.address,
                            isBaseToQuote: true,
                            isExactInput: false,
                            amount: parseEther("1"),
                            sqrtPriceLimitX96: 0,
                        }),
                    ).to.be.revertedWith("CH_NEAV")
                })
            })
        })
    })

    describe("taker open position from zero", async () => {
        beforeEach(async () => {
            await deposit(taker, vault, 1000, collateral)
        })

        describe("long", () => {
            it("verify base and quote amount in static call", async () => {
                // taker swap 1 USD for 6539527905092835/10^18 ETH
                const response = await clearingHouse.connect(taker).callStatic.openPosition({
                    baseToken: baseToken.address,
                    isBaseToQuote: false,
                    isExactInput: true,
                    amount: parseEther("1"),
                    sqrtPriceLimitX96: 0,
                })
                expect(response.deltaBase).to.be.eq("6539527905092835")
                expect(response.deltaQuote).to.be.eq("1000000000000000000")
            })

            it("increase ? position when exact input", async () => {
                const balanceBefore = await quoteToken.balanceOf(clearingHouse.address)

                // taker swap 1 USD for ? ETH
                await expect(
                    clearingHouse.connect(taker).openPosition({
                        baseToken: baseToken.address,
                        isBaseToQuote: false,
                        isExactInput: true,
                        amount: parseEther("1"),
                        sqrtPriceLimitX96: 0,
                    }),
                )
                    .to.emit(clearingHouse, "Swapped")
                    .withArgs(
                        taker.address, // trader
                        baseToken.address, // baseToken
                        "6539527905092835", // exchangedPositionSize
                        parseEther("-0.99"), // costBasis
                        parseEther("0.01"), // fee = 1 * 0.01
                    )

                const baseInfo = await clearingHouse.getTokenInfo(taker.address, baseToken.address)
                const quoteInfo = await clearingHouse.getTokenInfo(taker.address, quoteToken.address)
                expect(baseInfo.available.gt(parseEther("0"))).to.be.true
                expect(baseInfo.debt).be.deep.eq(parseEther("0"))
                expect(quoteInfo.available).be.deep.eq(parseEther("0"))
                expect(quoteInfo.debt).be.deep.eq(parseEther("1"))

                expect(await quoteToken.balanceOf(clearingHouse.address)).be.eq(balanceBefore.add(parseEther("0.01")))
            })

            describe("exact output", () => {
                it("mint more USD to buy exact 1 ETH", async () => {
                    // taker swap ? USD for 1 ETH -> quote to base -> fee is charged before swapping
                    //   exchanged notional = 71.9062751863 * 10884.6906588362 / (71.9062751863 - 1) - 10884.6906588362 = 153.508143394
                    //   taker fee = 153.508143394 / 0.99 * 0.01 = 1.550587307
                    const balanceBefore = await quoteToken.balanceOf(clearingHouse.address)

                    await expect(
                        clearingHouse.connect(taker).openPosition({
                            baseToken: baseToken.address,
                            isBaseToQuote: false,
                            isExactInput: false,
                            amount: parseEther("1"),
                            sqrtPriceLimitX96: 0,
                        }),
                    )
                        .to.emit(clearingHouse, "Swapped")
                        .withArgs(
                            taker.address, // trader
                            baseToken.address, // baseToken
                            parseEther("1"), // exchangedPositionSize
                            "-153508143394151325059", // costBasis
                            "1550587307011629547", // fee
                        )

                    const baseInfo = await clearingHouse.getTokenInfo(taker.address, baseToken.address)
                    const quoteInfo = await clearingHouse.getTokenInfo(taker.address, quoteToken.address)
                    expect(baseInfo.available).be.deep.eq(parseEther("1"))
                    expect(baseInfo.debt).be.deep.eq(parseEther("0"))
                    expect(quoteInfo.available).be.deep.eq(parseEther("0"))
                    expect(quoteInfo.debt.gt(parseEther("0"))).to.be.true

                    expect(await quoteToken.balanceOf(clearingHouse.address)).be.closeTo(
                        balanceBefore.add(parseEther("1.550587307011629547")),
                        1,
                    )
                })

                it("mint more USD to buy exact 1 ETH, when it has not enough available before", async () => {
                    await clearingHouse.connect(taker).mint(quoteToken.address, parseEther("50"))
                    const balanceBefore = await quoteToken.balanceOf(clearingHouse.address)

                    // taker swap ? USD for 1 ETH
                    await clearingHouse.connect(taker).openPosition({
                        baseToken: baseToken.address,
                        isBaseToQuote: false,
                        isExactInput: false,
                        amount: parseEther("1"),
                        sqrtPriceLimitX96: 0,
                    })
                    const baseInfo = await clearingHouse.getTokenInfo(taker.address, baseToken.address)
                    const quoteInfo = await clearingHouse.getTokenInfo(taker.address, quoteToken.address)
                    expect(baseInfo.available).be.deep.eq(parseEther("1"))
                    expect(baseInfo.debt).be.deep.eq(parseEther("0"))
                    expect(quoteInfo.available).be.deep.eq(parseEther("0"))
                    expect(quoteInfo.debt.gt(parseEther("0"))).to.be.true

                    expect(await quoteToken.balanceOf(clearingHouse.address)).be.closeTo(
                        balanceBefore.sub(parseEther("50")).add(parseEther("1.550587307011629547")),
                        1,
                    )
                })

                it("mint more but burn all of them after swap because there's enough available", async () => {
                    await clearingHouse.connect(taker).mint(quoteToken.address, parseEther("200"))

                    // taker swap ? USD for 1 ETH
                    await expect(
                        clearingHouse.connect(taker).openPosition({
                            baseToken: baseToken.address,
                            isBaseToQuote: false,
                            isExactInput: false,
                            amount: parseEther("1"),
                            sqrtPriceLimitX96: 0,
                        }),
                    ).not.emit(clearingHouse, "Minted")

                    const baseInfo = await clearingHouse.getTokenInfo(taker.address, baseToken.address)
                    const quoteInfo = await clearingHouse.getTokenInfo(taker.address, quoteToken.address)
                    expect(baseInfo.available.eq(parseEther("1"))).to.be.true
                    expect(baseInfo.debt.eq(parseEther("0"))).to.be.true
                    expect(quoteInfo.available.toString()).eq("0")
                    expect(quoteInfo.debt.gt(parseEther("0"))).to.be.true
                })
            })

            it("mint missing amount of vUSD for swapping", async () => {
                await clearingHouse.connect(taker).mint(quoteToken.address, parseEther("1"))
                const balanceBefore = await quoteToken.balanceOf(clearingHouse.address)

                // taker swap 2 USD for ? ETH
                // it will mint 1 more USD
                await expect(
                    clearingHouse.connect(taker).openPosition({
                        baseToken: baseToken.address,
                        isBaseToQuote: false,
                        isExactInput: true,
                        amount: parseEther("2"),
                        sqrtPriceLimitX96: 0,
                    }),
                )
                    .to.emit(clearingHouse, "Minted")
                    .withArgs(taker.address, quoteToken.address, parseEther("1"))

                const baseInfo = await clearingHouse.getTokenInfo(taker.address, baseToken.address)
                const quoteInfo = await clearingHouse.getTokenInfo(taker.address, quoteToken.address)
                expect(baseInfo.available.gt(parseEther("0"))).to.be.true
                expect(baseInfo.debt.eq(parseEther("0"))).to.be.true
                expect(quoteInfo.available.eq(parseEther("0"))).to.be.true
                expect(quoteInfo.debt.eq(parseEther("2"))).to.be.true

                expect(await quoteToken.balanceOf(clearingHouse.address)).to.be.eq(
                    balanceBefore.sub(parseEther("1")).add(parseEther("0.02")),
                )
            })

            it("does not mint anything if the vUSD is sufficient", async () => {
                await clearingHouse.connect(taker).mint(quoteToken.address, parseEther("1"))

                // taker swap 1 USD for ? ETH
                // wont mint anything
                await expect(
                    clearingHouse.connect(taker).openPosition({
                        baseToken: baseToken.address,
                        isBaseToQuote: false,
                        isExactInput: true,
                        amount: parseEther("1"),
                        sqrtPriceLimitX96: 0,
                    }),
                ).to.not.emit(clearingHouse, "Minted")

                const baseInfo = await clearingHouse.getTokenInfo(taker.address, baseToken.address)
                const quoteInfo = await clearingHouse.getTokenInfo(taker.address, quoteToken.address)
                expect(baseInfo.available.gt(parseEther("0"))).to.be.true
                expect(baseInfo.debt.eq(parseEther("0"))).to.be.true
                expect(quoteInfo.available.eq(parseEther("0"))).to.be.true
                expect(quoteInfo.debt.eq(parseEther("1"))).to.be.true
            })
        })

        describe("taker opens short from scratch", () => {
            it("settle funding payment")
            it("increase position from 0", async () => {
                // taker swap ? USD for 1 ETH -> base to quote -> fee is included in exchangedNotional
                //   taker exchangedNotional = 10884.6906588362 - 71.9062751863 * 10884.6906588362 / (71.9062751863 + 1) = 149.2970341856
                //   taker fee = 149.2970341856 * 0.01 = 1.492970341856

                const balanceBefore = await baseToken.balanceOf(clearingHouse.address)

                // taker swap 1 ETH for ? USD
                await expect(
                    clearingHouse.connect(taker).openPosition({
                        baseToken: baseToken.address,
                        isBaseToQuote: true,
                        isExactInput: true,
                        amount: parseEther("1"),
                        sqrtPriceLimitX96: 0,
                    }),
                )
                    .to.emit(clearingHouse, "Swapped")
                    .withArgs(
                        taker.address, // trader
                        baseToken.address, // baseToken
                        parseEther("-1"), // exchangedPositionSize
                        parseEther("149.297034185732877727"), // costBasis
                        parseEther("1.492970341857328778"), // fee: 149.297034185732877727 * 0.01 = 1.492970341857328777
                    )

                const baseInfo = await clearingHouse.getTokenInfo(taker.address, baseToken.address)
                const quoteInfo = await clearingHouse.getTokenInfo(taker.address, quoteToken.address)
                expect(baseInfo.available.eq(parseEther("0"))).to.be.true
                expect(baseInfo.debt.eq(parseEther("1"))).to.be.true
                expect(quoteInfo.available.gt(parseEther("0"))).to.be.true
                expect(quoteInfo.debt.eq(parseEther("0"))).to.be.true

                expect(await baseToken.balanceOf(clearingHouse.address)).to.be.eq(balanceBefore)
            })

            it("mint missing amount of vETH for swapping", async () => {
                await clearingHouse.connect(taker).mint(baseToken.address, parseEther("1"))
                const balanceBefore = await baseToken.balanceOf(clearingHouse.address)

                // taker swap 2 ETH for ? USD
                // it will mint 1 more ETH
                await expect(
                    clearingHouse.connect(taker).openPosition({
                        baseToken: baseToken.address,
                        isBaseToQuote: true,
                        isExactInput: true,
                        amount: parseEther("2"),
                        sqrtPriceLimitX96: 0,
                    }),
                )
                    .to.emit(clearingHouse, "Minted")
                    .withArgs(taker.address, baseToken.address, parseEther("1"))

                const baseInfo = await clearingHouse.getTokenInfo(taker.address, baseToken.address)
                const quoteInfo = await clearingHouse.getTokenInfo(taker.address, quoteToken.address)
                expect(baseInfo.available.eq(parseEther("0"))).to.be.true
                expect(baseInfo.debt.eq(parseEther("2"))).to.be.true
                expect(quoteInfo.available.gt(parseEther("0"))).to.be.true
                expect(quoteInfo.debt.eq(parseEther("0"))).to.be.true

                expect(await baseToken.balanceOf(clearingHouse.address)).to.be.eq(balanceBefore.sub(parseEther("1")))
            })

            it("will not mint anything if vETH is sufficient", async () => {
                await clearingHouse.connect(taker).mint(baseToken.address, parseEther("1"))

                // taker swap 1 ETH for ? USD
                // wont mint anything
                await expect(
                    clearingHouse.connect(taker).openPosition({
                        baseToken: baseToken.address,
                        isBaseToQuote: true,
                        isExactInput: true,
                        amount: parseEther("1"),
                        sqrtPriceLimitX96: 0,
                    }),
                ).to.not.emit(clearingHouse, "Minted")

                const baseInfo = await clearingHouse.getTokenInfo(taker.address, baseToken.address)
                const quoteInfo = await clearingHouse.getTokenInfo(taker.address, quoteToken.address)
                expect(baseInfo.available.eq(parseEther("0"))).to.be.true
                expect(baseInfo.debt.eq(parseEther("1"))).to.be.true
                expect(quoteInfo.available.gt(parseEther("0"))).to.be.true
                expect(quoteInfo.debt.eq(parseEther("0"))).to.be.true
            })
        })
    })

    describe("opening long first then", () => {
        beforeEach(async () => {
            await deposit(taker, vault, 1000, collateral)

            // 71.9062751863 - 884.6906588359 ^ 2  / (10884.6906588362 + 2 * 0.99) = 0.01307786649
            // taker swap 2 USD for 0.01307786649 ETH
            await clearingHouse.connect(taker).openPosition({
                baseToken: baseToken.address,
                isBaseToQuote: false,
                isExactInput: true,
                amount: parseEther("2"),
                sqrtPriceLimitX96: 0,
            })
            // virtual base liquidity = 71.9062751863 - 0.01307786649 = 71.8931973198
            // virtual quote liquidity = 10884.6906588362 + 2 * 0.99 = 10886.6706588362
        })

        it("increase position", async () => {
            const balanceBefore = await quoteToken.balanceOf(clearingHouse.address)

            const baseInfoBefore = await clearingHouse.getTokenInfo(taker.address, baseToken.address)
            const quoteInfoBefore = await clearingHouse.getTokenInfo(taker.address, quoteToken.address)

            // taker swap 1 USD for ? ETH again
            await expect(
                clearingHouse.connect(taker).openPosition({
                    baseToken: baseToken.address,
                    isBaseToQuote: false,
                    isExactInput: true,
                    amount: parseEther("1"),
                    sqrtPriceLimitX96: 0,
                }),
            )
                .to.emit(clearingHouse, "Minted")
                .withArgs(taker.address, quoteToken.address, parseEther("1"))

            // increase ? USD debt, increase 1 ETH available, the rest remains the same
            const baseInfoAfter = await clearingHouse.getTokenInfo(taker.address, baseToken.address)
            const quoteInfoAfter = await clearingHouse.getTokenInfo(taker.address, quoteToken.address)
            const increasedQuoteDebt = quoteInfoAfter.debt.sub(quoteInfoBefore.debt)
            const increasedBaseAvailable = baseInfoAfter.available.sub(baseInfoBefore.available)
            expect(increasedQuoteDebt).deep.eq(parseEther("1"))
            expect(increasedBaseAvailable.gt(parseEther("0"))).to.be.true
            expect(baseInfoAfter.debt.sub(baseInfoBefore.debt)).deep.eq(parseEther("0"))
            expect(quoteInfoAfter.available.sub(quoteInfoBefore.available)).deep.eq(parseEther("0"))

            // pos size: 0.01961501593
            expect(await clearingHouse.getPositionSize(taker.address, baseToken.address)).to.eq("19615015933642630")
            expect(await clearingHouse.getNetQuoteBalance(taker.address)).to.eq(parseEther("-3"))

            expect(await quoteToken.balanceOf(clearingHouse.address)).to.eq(balanceBefore.add(parseEther("0.01")))
        })

        it("reduce position", async () => {
            const baseInfoBefore = await clearingHouse.getTokenInfo(taker.address, baseToken.address)
            const quoteInfoBefore = await clearingHouse.getTokenInfo(taker.address, quoteToken.address)

            // reduced base = 0.006538933220746360
            const reducedBase = baseInfoBefore.available.div(2)
            // taker reduce 50% ETH position for ? USD
            await expect(
                clearingHouse.connect(taker).openPosition({
                    baseToken: baseToken.address,
                    isBaseToQuote: true,
                    isExactInput: true,
                    amount: reducedBase,
                    sqrtPriceLimitX96: 0,
                }),
            ).not.emit(clearingHouse, "Minted")

            // increase ? USD available, reduce 1 ETH available, the rest remains the same
            const baseInfoAfter = await clearingHouse.getTokenInfo(taker.address, baseToken.address)
            const quoteInfoAfter = await clearingHouse.getTokenInfo(taker.address, quoteToken.address)
            const increasedQuoteAvailable = quoteInfoAfter.available.sub(quoteInfoBefore.available)
            const reducedBaseAvailable = baseInfoBefore.available.sub(baseInfoAfter.available)
            expect(increasedQuoteAvailable).to.equal("0")
            expect(reducedBaseAvailable).deep.eq(reducedBase)
            expect(baseInfoAfter.debt.sub(baseInfoBefore.debt)).deep.eq(parseEther("0"))
            expect(quoteInfoBefore.debt.sub(quoteInfoAfter.debt)).to.be.above("0")

            // pos size: 0.006538933220746361
            expect(await clearingHouse.getPositionSize(taker.address, baseToken.address)).to.eq("6538933220746361")
            expect(await clearingHouse.getNetQuoteBalance(taker.address)).to.eq(
                quoteInfoAfter.available.sub(quoteInfoAfter.debt),
            )
        })

        it("close position, base's available/debt will be 0, settle to owedRealizedPnl", async () => {
            // expect taker has 2 USD worth ETH
            const baseTokenInfo = await clearingHouse.getTokenInfo(taker.address, baseToken.address)
            const posSize = baseTokenInfo.available.sub(baseTokenInfo.debt)
            // posSize = 0.013077866441492721

            // taker sells 0.013077866441492721 ETH
            // CH will boost the ETH amount in, but then pool will cut the exact percentage as fee,
            //   so the actual swapped in amount is still 0.013077866441492721
            //   amount out would be:
            //     10886.6706588362 - 884.6906588359 ^ 2 / (71.8931973198 + 0.013077866441492721) = 1.98000000000026751159
            // taker gets 1.98000000000026751159 * 0.99 = 1.9602000000002648364741
            await expect(
                clearingHouse.connect(taker).openPosition({
                    baseToken: baseToken.address,
                    isBaseToQuote: true,
                    isExactInput: true,
                    amount: posSize,
                    sqrtPriceLimitX96: 0,
                }),
            ).not.emit(clearingHouse, "Minted")

            // base debt and available will be 0
            {
                const baseTokenInfo = await clearingHouse.getTokenInfo(taker.address, baseToken.address)
                expect(baseTokenInfo.available).deep.eq(parseEther("0"))
                expect(baseTokenInfo.debt).deep.eq(parseEther("0"))
                const quoteTokenInfo = await clearingHouse.getTokenInfo(taker.address, quoteToken.address)
                expect(quoteTokenInfo.available).eq(0)
                expect(quoteTokenInfo.debt).eq(0)

                // 2 - 1.9602000000002648364741 = 0.0398000015
                const pnl = await clearingHouse.getOwedRealizedPnl(taker.address)
                expect(pnl).eq(parseEther("-0.039800000000000043")) // fee loss
            }

            // free collateral will be less than original number bcs of fees
            // 1000 - 0.039800000000000043 = 999.9602
            const freeCollateral = await vault.getFreeCollateral(taker.address)
            expect(freeCollateral).deep.eq(parseUnits("999.960199", 6))

            expect(await clearingHouse.getPositionSize(taker.address, baseToken.address)).to.eq("0")
        })

        it("close position with profit", async () => {
            // expect taker has 2 USD worth ETH
            const baseTokenInfo = await clearingHouse.getTokenInfo(taker.address, baseToken.address)
            const posSize = baseTokenInfo.available.sub(baseTokenInfo.debt)
            // posSize = 0.013077866441492721

            // prepare collateral for carol
            const carolAmount = parseEther("1000")
            await collateral.connect(admin).mint(carol.address, carolAmount)
            await deposit(carol, vault, 1000, collateral)

            // carol pays $1000 for ETH long
            // 71.8931973198 - 884.6906588359 ^ 2 / (10886.6706588362 + 990) = 5.9927792385
            await clearingHouse.connect(carol).openPosition({
                baseToken: baseToken.address,
                isBaseToQuote: false,
                isExactInput: true,
                amount: carolAmount,
                sqrtPriceLimitX96: 0,
            })
            // virtual base liquidity = 71.8931973198 - 5.9927792385 = 65.9004180813
            // virtual quote liquidity = 10886.6706588362 + 990 = 11876.6706588362

            // CH will boost the ETH amount in, but then pool will cut the exact percentage as fee,
            //   so the actual swapped in amount is still 0.013077866441492721
            //   amount out would be:
            //     11876.6706588362 - 884.6906588359 ^ 2 / (65.9004180813 + 0.013077866441492721) = 2.3564447634
            // taker gets 2.3564447634 * 0.99 = 2.3328803158
            await clearingHouse.connect(taker).openPosition({
                baseToken: baseToken.address,
                isBaseToQuote: true,
                isExactInput: true,
                amount: posSize,
                sqrtPriceLimitX96: 0,
            })

            // mock index price to market price
            mockedBaseAggregator.smocked.latestRoundData.will.return.with(async () => {
                return [0, parseUnits("103.12129", 6), 0, 0, 0]
            })

            // base debt and available will be 0
            {
                const baseTokenInfo = await clearingHouse.getTokenInfo(taker.address, baseToken.address)
                expect(baseTokenInfo.available).deep.eq(parseEther("0"))
                expect(baseTokenInfo.debt).deep.eq(parseEther("0"))
                const quoteTokenInfo = await clearingHouse.getTokenInfo(taker.address, quoteToken.address)
                expect(quoteTokenInfo.available).eq(0)
                expect(quoteTokenInfo.debt).deep.eq(0)

                // pnl = 2.3328803158 - 2 = 0.3328803158
                const pnl = await clearingHouse.getOwedRealizedPnl(taker.address)
                expect(pnl).deep.eq(parseEther("0.332880320006927809"))
            }

            // collateral will be less than original number bcs of fees
            const freeCollateral = await vault.getFreeCollateral(taker.address)
            expect(freeCollateral).deep.eq(parseUnits("1000.33288", 6))

            expect(await clearingHouse.getPositionSize(taker.address, baseToken.address)).to.eq("0")
        })

        it("close position with loss", async () => {
            // expect taker has 2 USD worth ETH
            const baseTokenInfo = await clearingHouse.getTokenInfo(taker.address, baseToken.address)
            const posSize = baseTokenInfo.available.sub(baseTokenInfo.debt)
            const balanceBefore = await baseToken.balanceOf(clearingHouse.address)

            // prepare collateral for carol
            const carolAmount = parseEther("1000")
            await collateral.connect(admin).mint(carol.address, carolAmount)
            await deposit(carol, vault, 1000, collateral)

            // carol pays for $1000 ETH short
            // B2QFee: CH actually gets 1000 / 0.99 = 1010.101010101 quote
            // 884.6906588359 ^ 2 / (10886.6706588362 - 1010.101010101) - 71.8931973198 = 7.3526936796
            await clearingHouse.connect(carol).openPosition({
                baseToken: baseToken.address,
                isBaseToQuote: true,
                isExactInput: false,
                amount: carolAmount,
                sqrtPriceLimitX96: 0,
            })

            // 0.0130787866
            expect(await baseToken.balanceOf(clearingHouse.address)).to.eq(balanceBefore)

            // virtual base liquidity = 71.8931973198 + 7.3526936796 = 79.2458909994
            // virtual quote liquidity = 10886.6706588362 - 1010.101010101 = 9876.5696487352

            // CH will boost the ETH amount in, but then pool will cut the exact percentage as fee,
            //   so the actual swapped in amount is still 0.013077866441492721
            //   amount out would be:
            //     9876.5696487352 - 884.6906588359 ^ 2 / (79.2458909994 + 0.013077866441492721) = 1.6296510132
            // taker gets 1.6296510132 * 0.99 = 1.6133545031
            await clearingHouse.connect(taker).openPosition({
                baseToken: baseToken.address,
                isBaseToQuote: true,
                isExactInput: true,
                amount: posSize,
                sqrtPriceLimitX96: 0,
            })

            // base debt and available will be 0
            {
                const baseTokenInfo = await clearingHouse.getTokenInfo(taker.address, baseToken.address)
                expect(baseTokenInfo.available).deep.eq(parseEther("0"))
                expect(baseTokenInfo.debt).deep.eq(parseEther("0"))
                const quoteTokenInfo = await clearingHouse.getTokenInfo(taker.address, quoteToken.address)
                expect(quoteTokenInfo.available).eq(0)
                expect(quoteTokenInfo.debt).deep.eq(0)

                // pnl = 1.6133545031 -2 = -0.3866454969
                const pnl = await clearingHouse.getOwedRealizedPnl(taker.address)
                expect(pnl).deep.eq(parseEther("-0.386645498819609266"))
            }

            // collateral will be less than original number bcs of fees
            const freeCollateral = await vault.getFreeCollateral(taker.address)
            expect(freeCollateral).deep.eq(parseUnits("999.613354", collateralDecimals))

            expect(await clearingHouse.getPositionSize(taker.address, baseToken.address)).to.eq("0")
        })

        it("open larger reverse position", async () => {
            // taker has 2 USD worth ETH long position
            // then opens 10 USD worth ETH short position
            await clearingHouse.connect(taker).openPosition({
                baseToken: baseToken.address,
                isBaseToQuote: true,
                isExactInput: false,
                amount: parseEther("10"),
                sqrtPriceLimitX96: 0,
            })

            // position size = -0.05368894844
            expect(await clearingHouse.getPositionSize(taker.address, baseToken.address)).to.eq("-53688948443543907")

            // openNotional = 8.0412624948
            expect(await clearingHouse.getOpenNotional(taker.address, baseToken.address)).to.eq("8041262494847024252")

            // realizedPnl = -0.04126249485
            expect(await clearingHouse.getOwedRealizedPnl(taker.address)).to.eq("-41262494847024252")
        })

        // TODO: blocked by TWAP based _getDebtValue
        it.skip("force error, can't open another long if it's under collateral", async () => {
            // prepare collateral for carol
            const carolAmount = parseUnits("1000", collateralDecimals)
            await collateral.connect(admin).mint(carol.address, carolAmount)
            await deposit(carol, vault, 1000, collateral)

            // carol open short to make taker under collateral
            await clearingHouse.connect(carol).openPosition({
                baseToken: baseToken.address,
                isBaseToQuote: true,
                isExactInput: false,
                amount: carolAmount,
                sqrtPriceLimitX96: 0,
            })

            // taker want to increase position but he's under collateral
            // TODO expect taker's margin ratio < mmRatio
            await expect(
                clearingHouse.connect(taker).openPosition({
                    baseToken: baseToken.address,
                    isBaseToQuote: false,
                    isExactInput: true,
                    amount: 1,
                    sqrtPriceLimitX96: 0,
                }),
            ).to.be.revertedWith("CH_CNE")
        })
    })

    describe("opening short first then", () => {
        beforeEach(async () => {
            await deposit(taker, vault, 1000, collateral)
            // taker swap ? ETH for 2 USD
            await clearingHouse.connect(taker).openPosition({
                baseToken: baseToken.address,
                isBaseToQuote: true,
                isExactInput: false,
                amount: parseEther("2"),
                sqrtPriceLimitX96: 0,
            })
        })
        it("increase position")
        it("reduce position")
        it("close position")

        it("open larger reverse position", async () => {
            // taker has 2 USD worth ETH short position
            // then opens 10 USD worth ETH long position
            await clearingHouse.connect(taker).openPosition({
                baseToken: baseToken.address,
                isBaseToQuote: false, // quote to base
                isExactInput: true,
                amount: parseEther("10"),
                sqrtPriceLimitX96: 0,
            })

            expect(await clearingHouse.getPositionSize(taker.address, baseToken.address)).to.eq("52017742202701754")

            // because taker opens a larger reverse position, her position is closed and increase a new one
            // she spent $8 for the 2nd tx, openNotional = -8 - realizedPnlBcsOfFeeFromPrevTx
            const openNotional = await clearingHouse.getOpenNotional(taker.address, baseToken.address)
            const realizedPnl = await clearingHouse.getOwedRealizedPnl(taker.address)
            expect(openNotional).to.eq("-7957914633138379981")
            expect(openNotional).to.eq(parseEther("-8").sub(realizedPnl))
        })
    })

    // https://docs.google.com/spreadsheets/d/1xcWBBcQYwWuWRdlHtNv64tOjrBCnnvj_t1WEJaQv8EY/edit#gid=1258612497
    describe("maker has order out of price range", () => {
        it("will not affect her range order")
    })

    describe("maker has order within price range", () => {
        it("will not affect her range order")
        it("force error if she is going to liquidate herself")
    })

    describe("markets number exceeded", () => {
        beforeEach(async () => {
            await clearingHouse.connect(maker).mint(baseToken2.address, parseEther("65.943787")) // should only mint exact amount
            await clearingHouse.connect(maker).mint(quoteToken.address, parseEther("10000"))
            await clearingHouse.connect(maker).addLiquidity({
                baseToken: baseToken2.address,
                base: parseEther("65.943787"),
                quote: parseEther("10000"),
                lowerTick,
                upperTick,
                minBase: 0,
                minQuote: 0,
                deadline: ethers.constants.MaxUint256,
            })

            await deposit(taker, vault, 1000, collateral)
            await clearingHouse.setMaxMarketsPerAccount("1")
        })
        it("after closing position on market A, could open on market B ", async () => {
            await clearingHouse.connect(taker).openPosition({
                baseToken: baseToken.address,
                isBaseToQuote: true,
                isExactInput: true,
                amount: parseEther("1"),
                sqrtPriceLimitX96: 0,
            })

            // close market of baseToken
            await clearingHouse.connect(taker).openPosition({
                baseToken: baseToken.address,
                isBaseToQuote: false,
                isExactInput: false,
                amount: parseEther("1"),
                sqrtPriceLimitX96: 0,
            })

            await expect(
                clearingHouse.connect(taker).openPosition({
                    baseToken: baseToken2.address,
                    isBaseToQuote: true,
                    isExactInput: true,
                    amount: parseEther("10"),
                    sqrtPriceLimitX96: 0,
                }),
            ).to.emit(clearingHouse, "Swapped")
        })

        it("force error, markets number exceeded", async () => {
            await expect(
                clearingHouse.connect(taker).openPosition({
                    baseToken: baseToken.address,
                    isBaseToQuote: true,
                    isExactInput: true,
                    amount: parseEther("1"),
                    sqrtPriceLimitX96: 0,
                }),
            ).to.emit(clearingHouse, "Swapped")

            await expect(
                clearingHouse.connect(taker).openPosition({
                    baseToken: baseToken2.address,
                    isBaseToQuote: true,
                    isExactInput: true,
                    amount: parseEther("1"),
                    sqrtPriceLimitX96: 0,
                }),
            ).to.be.revertedWith("CH_MNE")
        })
    })
})
