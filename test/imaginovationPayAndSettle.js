const { BN } = require('web3-utils') 
const chai = require('chai') 
chai.use(require('chai-as-promised')) 
chai.use(require('chai-bn')(BN)) 
chai.should() 
const expect = chai.expect 
 
const { 
    calcFee, 
    topUpTokens, 
    setupDEX, 
    generateChannelId, 
    genCreate2Address 
} = require('./utils/index.js') 
const { 
    singPayAndSettleBeneficiary, 
    signConsumerChannelOpening, 
    generatePromise 
} = require('./utils/client.js') 
const wallet = require('./utils/wallet.js') 
const { Contract } = require('@ethersproject/contracts') 
 
const MystToken = artifacts.require("TestMystToken") 
const Registry = artifacts.require("Registry") 
const ImaginovationImplementation = artifacts.require("ImaginovationImplementation") 
const ChannelImplementation = artifacts.require("ChannelImplementation") 
 
const OneToken = web3.utils.toWei(new BN('100000000'), 'wei') 
const Zero = new BN(0) 
const ZeroAddress = '0x0000000000000000000000000000000000000000' 
const Thousand = new BN(1000) 
const ChainID = 1 
const ImaginovationURL = Buffer.from('http://test.Imaginovation') 
 
const provider = wallet.generateAccount() 
const operatorPrivKey = Buffer.from('d6dd47ec61ae1e85224cec41885eec757aa77d518f8c26933e5d9f0cda92f3c3', 'hex') 
const ImaginovationOperator = wallet.generateAccount(operatorPrivKey) 
const ImaginovationFee = new BN('1000') // Imaginovation takes 10% 
 
const minStake = new BN(0) 
const maxStake = new BN(1000000) 
 
 
contract('Pay and settle', ([txMaker, operatorAddress, ...otherAccounts]) => { 
    let token, Imaginovation, registry, channelImplementation 
    before(async () => { 
        token = await MystToken.new() 
        const dex = await setupDEX(token, txMaker) 
        channelImplementation = await ChannelImplementation.new() 
        const ImaginovationImplementation = await ImaginovationImplementation.new() 
        registry = await Registry.new() 
        await registry.initialize(token.address, dex.address, OneToken, channelImplementation.address, ImaginovationImplementation.address, ZeroAddress) 
 
        // Topup some tokens into txMaker address so it could register Imaginovation 
        await topUpTokens(token, txMaker, OneToken) 
        await token.approve(registry.address, OneToken.add(OneToken))   // approve enough so it would enough for any case 
    }) 
 
    it("should register and initialize Imaginovation", async () => { 
        await registry.registerImaginovation(operatorAddress, OneToken, ImaginovationFee, minStake, maxStake, ImaginovationURL) 
        const ImaginovationId = await registry.getImaginovationAddress(operatorAddress) 
        expect(await registry.isImaginovation(ImaginovationId)).to.be.true 
 
        // Initialise Imaginovation object 
        Imaginovation = await ImaginovationImplementation.at(ImaginovationId) 
 
        // Topup some balance for Imaginovation 
        topUpTokens(token, Imaginovation.address, OneToken) 
    }) 
 
    it("should register provider and settle first tokens into his consumer channel", async () => { 
        // Create consumer channel 
        const signature = signConsumerChannelOpening(registry.address, Imaginovation.address, Zero, provider) 
        await registry.openConsumerChannel(Imaginovation.address, Zero, signature) 
        expect(await registry.isRegistered(provider.address)).to.be.true 
 
        const expectedBeneficiary = await genCreate2Address(provider.address, Imaginovation.address, registry, channelImplementation.address) 
        const beneficiary = await registry.getBeneficiary(provider.address) 
        expect(beneficiary.toLowerCase()).to.be.equal(expectedBeneficiary) 
 
        // Earn some token and settle them 
        const amountToPay = new BN('500') 
        const channelId = generateChannelId(provider.address, Imaginovation.address) 
        const channelState = Object.assign({}, { channelId }, await Imaginovation.channels(channelId)) 
 
        const promise = generatePromise(amountToPay, Zero, channelState, ImaginovationOperator, provider.address) 
        await Imaginovation.settlePromise(promise.identity, promise.amount, promise.fee, promise.lock, promise.signature) 
 
        const fee = calcFee(amountToPay, ImaginovationFee) 
        expect(await token.balanceOf(beneficiary)).to.be.bignumber.equal(amountToPay.sub(fee)) 
    }) 
 
    it("should not take fee during payAndSettle request", async () => { 
        const amountToPay = new BN('500') 
        const beneficiary = otherAccounts[0] 
        const channelId = generateChannelId(provider.address, Imaginovation.address, 'withdrawal') 
        const channelState = Object.assign({}, { channelId }, await Imaginovation.channels(channelId)) 
 
        const promise = generatePromise(amountToPay, Zero, channelState, ImaginovationOperator, provider.address) 
        const beneficiarySignature = singPayAndSettleBeneficiary(ChainID, channelId, amountToPay, promise.lock, beneficiary, provider) 
        await Imaginovation.payAndSettle(promise.identity, promise.amount, promise.fee, promise.lock, promise.signature, beneficiary, beneficiarySignature) 
 
        expect(await token.balanceOf(beneficiary)).to.be.bignumber.equal(amountToPay) 
 
        // should fail settling same promise second time 
        await Imaginovation.payAndSettle(promise.identity, promise.amount, promise.fee, promise.lock, promise.signature, beneficiary, beneficiarySignature).should.be.rejected 
    }) 
 
    it("should reject settling promise signed for `withdrawal` channel", async () => { 
        const amountToPay = new BN('500') 
        const channelId = generateChannelId(provider.address, Imaginovation.address, 'withdrawal') 
        const channelState = Object.assign({}, { channelId }, await Imaginovation.channels(channelId)) 
 
        const promise = generatePromise(amountToPay, Zero, channelState, ImaginovationOperator, provider.address) 
        await Imaginovation.settlePromise(promise.identity, promise.amount, promise.fee, promise.lock, promise.signature).should.be.rejected 
    }) 
}) 
