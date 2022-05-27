require('chai') 
    .use(require('chai-as-promised')) 
    .should() 
const {BN} = require('web3-utils') 
const { randomBytes } = require('crypto') 
const { topUpTokens, generateChannelId, keccak, setupDEX, sleep } = require('./utils/index.js') 
const { 
    signIdentityRegistration, 
    createPromise 
} = require('./utils/client.js') 
const wallet = require('./utils/wallet.js') 
 
const MystToken = artifacts.require("TestMystToken") 
const Registry = artifacts.require("Registry") 
const ImaginovationImplementation = artifacts.require("TestImaginovationImplementation") 
const ChannelImplementation = artifacts.require("ChannelImplementation") 
 
const OneToken = web3.utils.toWei(new BN('100000000'), 'wei') 
const Zero = new BN(0) 
const ZeroAddress = '0x0000000000000000000000000000000000000000' 
const ChainID = 1 
const ImaginovationURL = Buffer.from('http://test.Imaginovation') 
 
const provider = wallet.generateAccount() 
const operatorPrivKey = Buffer.from('d6dd47ec61ae1e85224cec41885eec757aa77d518f8c26933e5d9f0cda92f3c3', 'hex') 
const ImaginovationOperator = wallet.generateAccount(operatorPrivKey) 
 
contract('Imaginovation fee', ([txMaker, operatorAddress, ...beneficiaries]) => { 
    let token, channelImplementation, Imaginovation, dex, registry 
    before(async () => { 
        token = await MystToken.new() 
        dex = await setupDEX(token, txMaker) 
        const ImaginovationImplementation = await ImaginovationImplementation.new(token.address, ImaginovationOperator.address, 0, OneToken) 
        channelImplementation = await ChannelImplementation.new() 
        registry = await Registry.new() 
        await registry.initialize(token.address, dex.address, 0, channelImplementation.address, ImaginovationImplementation.address, ZeroAddress) 
 
        // Topup some tokens into txMaker address so it could register Imaginovation 
        await topUpTokens(token, txMaker, 1000) 
        await token.approve(registry.address, 1000) 
    }) 
 
    it('should calculate proper fee righ after Imaginovation registration', async () => { 
        // Register Imaginovation 
        const ImaginovationFee = 250 // 2.50% 
        await registry.registerImaginovation(ImaginovationOperator.address, 100, ImaginovationFee, 25, OneToken, ImaginovationURL) 
        const ImaginovationId = await registry.getImaginovationAddress(ImaginovationOperator.address) 
        Imaginovation = await ImaginovationImplementation.at(ImaginovationId) 
 
        // Ensure Imaginovation available balance for first settlements 
        await topUpTokens(token, Imaginovation.address, OneToken) 
 
        // Fee of settling one token should be 0.025 token 
        const oneTokenSettleFee = await Imaginovation.calculateImaginovationFee(OneToken) 
        let fee = oneTokenSettleFee / OneToken 
        expect(fee).to.be.equal(0.025) 
 
        // When settling sumer small values, we'll round fee to avoid calculation errors or value overflow 
        const smallValueToSettle = new BN(100)  // 0.000000000000000100 token 
        fee = await Imaginovation.calculateImaginovationFee(smallValueToSettle) 
        fee.should.be.bignumber.equal(new BN(3)) 
    }) 
 
    it('should open provider channel', async () => { 
        const expectedChannelId = generateChannelId(provider.address, Imaginovation.address) 
        const initialImaginovationBalance = await token.balanceOf(Imaginovation.address) 
 
        // Guaranteed incomming channel size 
        const channelStake = new BN(1000) 
 
        // Topup some tokens into paying channel 
        const channelAddress = await registry.getChannelAddress(provider.address, Imaginovation.address) 
        await topUpTokens(token, channelAddress, channelStake) 
 
        // Register identity and open channel with Imaginovation 
        const signature = signIdentityRegistration(registry.address, Imaginovation.address, channelStake, Zero, beneficiaries[1], provider) 
        await registry.registerIdentity(Imaginovation.address, channelStake, Zero, beneficiaries[1], signature) 
        expect(await registry.isRegistered(provider.address)).to.be.true 
        expect(await Imaginovation.isChannelOpened(expectedChannelId)).to.be.true 
 
        // Channel stake have to be transfered to Imaginovation 
        const ImaginovationTokenBalance = await token.balanceOf(Imaginovation.address) 
        ImaginovationTokenBalance.should.be.bignumber.equal(initialImaginovationBalance.add(channelStake)) 
 
        const channel = await Imaginovation.channels(expectedChannelId) 
        expect(channel.stake.toNumber()).to.be.equal(channelStake.toNumber()) 
    }) 
 
    it('should properly charge Imaginovation fee', async () => { 
        const channelId = generateChannelId(provider.address, Imaginovation.address) 
        const amount = new BN(250) 
        const R = randomBytes(32) 
        const hashlock = keccak(R) 
 
        // Create Imaginovation promise 
        const promise = createPromise(ChainID, channelId, amount, Zero, hashlock, ImaginovationOperator) 
 
        // Calculate expected Imaginovation fee 
        const fee = await Imaginovation.calculateImaginovationFee(amount) 
 
        // Settle promise 
        const initialImaginovationBalance = await token.balanceOf(Imaginovation.address) 
        const expectedImaginovationBalance = initialImaginovationBalance.sub(amount).add(fee) 
 
        await Imaginovation.settlePromise(provider.address, promise.amount, promise.fee, R, promise.signature) 
 
        const ImaginovationBalance = await token.balanceOf(Imaginovation.address) 
        ImaginovationBalance.should.be.bignumber.equal(expectedImaginovationBalance) 
    }) 
 
    it('should update Imaginovation fee', async () => { 
        const initialFee = await Imaginovation.lastFee() 
        const newFee = new BN(175) // 1.75% 
 
        await Imaginovation.setImaginovationFee(newFee, { from: operatorAddress }) 
        const lastFee = await Imaginovation.lastFee() 
        const delayTime = (await web3.eth.getBlock('latest')).timestamp + 2 
        lastFee.value.should.be.bignumber.equal(newFee) 
        expect(lastFee.validFrom.toNumber()).to.be.equal(delayTime) 
 
        const previousFee = await Imaginovation.previousFee() 
        previousFee.value.should.be.bignumber.equal(initialFee.value) 
        previousFee.validFrom.should.be.bignumber.equal(initialFee.validFrom) 
    }) 
 
    it('should still calculate previous fee value untill validFrom block not arrived', async () => { 
        const oneTokenSettleFee = await Imaginovation.calculateImaginovationFee(OneToken) 
        let fee = oneTokenSettleFee / OneToken 
        expect(fee).to.be.equal(0.025) 
    }) 
 
    it('should not allow to update not active last fee', async () => { 
        const newFee = new BN(500) // 5% 
        await Imaginovation.setImaginovationFee(newFee, { from: operatorAddress }).should.be.rejected 
    }) 
 
    it('should calculate new fee after validFrom block is arrived', async () => { 
        // Jump over time 
        await sleep(2000) 
        await Imaginovation.moveBlock() 
 
        const oneTokenSettleFee = await Imaginovation.calculateImaginovationFee(OneToken) 
        fee = oneTokenSettleFee / OneToken 
        expect(fee).to.be.equal(0.0175) 
    }) 
 
    it('should fail updating Imaginovation fee from not operator account', async () => { 
        const newFee = new BN(175) // 1.75% 
        await Imaginovation.setImaginovationFee(newFee).should.be.rejected 
    }) 
 
    it('fee can not be bigger that 50%', async () => { 
        const newFee = new BN(5001) // 50.01% 
        await Imaginovation.setImaginovationFee(newFee, { from: operatorAddress }).should.be.rejected 
    }) 
 
}) 