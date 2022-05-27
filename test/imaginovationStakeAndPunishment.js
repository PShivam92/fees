require('chai') 
    .use(require('chai-as-promised')) 
    .should() 
const {BN} = require('web3-utils') 
const { randomBytes } = require('crypto') 
 
const { topUpTokens, setupDEX, generateChannelId, keccak, sleep } = require('./utils/index.js') 
const { 
    signIdentityRegistration, 
    signChannelImaginovationReturnRequest, 
    createPromise, 
    generatePromise 
} = require('./utils/client.js') 
const wallet = require('./utils/wallet.js') 
const { zeroAddress } = require('ethereumjs-util') 
 
const MystToken = artifacts.require("TestMystToken") 
const Registry = artifacts.require("Registry") 
const ImaginovationImplementation = artifacts.require("TestImaginovationImplementation") 
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
 
contract('Imaginovation stake and punishment management', ([txMaker, operatorAddress, ...beneficiaries]) => { 
    let token, Imaginovation, registry, stake 
    before(async () => { 
        stake = OneToken 
 
        token = await MystToken.new() 
        const dex = await setupDEX(token, txMaker) 
        const ImaginovationImplementation = await ImaginovationImplementation.new(token.address, ImaginovationOperator.address, 0, OneToken) 
        const channelImplementation = await ChannelImplementation.new() 
        registry = await Registry.new() 
        await registry.initialize(token.address, dex.address, stake, channelImplementation.address, ImaginovationImplementation.address, ZeroAddress) 
 
        // Topup some tokens into txMaker address so it could register Imaginovation 
        await topUpTokens(token, txMaker, OneToken) 
        await token.approve(registry.address, OneToken)   // approve a lot so it would enough for any case 
    }) 
 
    it('should reject Imaginovation registration if he do not pay enough stake', async () => { 
        const stateAmount = stake - 1 
        await registry.registerImaginovation(ImaginovationOperator.address, stateAmount, Zero, 25, OneToken, ImaginovationURL).should.be.rejected 
    }) 
 
    it('should register Imaginovation when stake is ok', async () => { 
        await registry.registerImaginovation(ImaginovationOperator.address, stake, Zero, 25, OneToken, ImaginovationURL) 
        const ImaginovationId = await registry.getImaginovationAddress(ImaginovationOperator.address) 
        Imaginovation = await ImaginovationImplementation.at(ImaginovationId) 
        expect(await registry.isImaginovation(Imaginovation.address)).to.be.true 
    }) 
 
    it('Imaginovation should have available balance after sending some tokens into him', async () => { 
        let availableBalance = await Imaginovation.availableBalance() 
        availableBalance.should.be.bignumber.equal(Zero) 
 
        const amount = new BN(1000) 
        await topUpTokens(token, Imaginovation.address, amount) 
 
        availableBalance = await Imaginovation.availableBalance() 
        availableBalance.should.be.bignumber.equal(amount) 
    }) 
 
    it('should open provider channel and calculate zero available balance', async () => { 
        const expectedChannelId = generateChannelId(provider.address, Imaginovation.address) 
        const initialImaginovationBalance = await token.balanceOf(Imaginovation.address) 
        const initialAvailableBalance = await Imaginovation.availableBalance() 
 
        // Guaranteed incomming channel size 
        const channelStake = new BN(1000) 
 
        // Topup some tokens into paying channel 
        const channelAddress = await registry.getChannelAddress(provider.address, Imaginovation.address) 
        await topUpTokens(token, channelAddress, channelStake) 
 
        // Register identity and open channel with Imaginovation 
        const signature = signIdentityRegistration(registry.address, Imaginovation.address, channelStake, Zero, beneficiaries[0], provider) 
        await registry.registerIdentity(Imaginovation.address, channelStake, Zero, beneficiaries[0], signature) 
        expect(await registry.isRegistered(provider.address)).to.be.true 
        expect(await Imaginovation.isChannelOpened(expectedChannelId)).to.be.true 
 
        // Channel stake have to be transfered to Imaginovation 
        const ImaginovationTokenBalance = await token.balanceOf(Imaginovation.address) 
        ImaginovationTokenBalance.should.be.bignumber.equal(initialImaginovationBalance.add(channelStake)) 
 
        const channel = await Imaginovation.channels(expectedChannelId) 
        expect(channel.stake.toNumber()).to.be.equal(channelStake.toNumber()) 
 
        // Imaginovation available balance should stay unchanged 
        const availableBalance = await Imaginovation.availableBalance() 
        availableBalance.should.be.bignumber.equal(initialAvailableBalance) 
    }) 
 
    it('should settle promise', async () => { 
        const channelId = generateChannelId(provider.address, Imaginovation.address) 
        const amount = new BN(250) 
        const R = randomBytes(32) 
        const hashlock = keccak(R) 
 
        // Create Imaginovation promise and settle it 
        const promise = createPromise(ChainID, channelId, amount, Zero, hashlock, ImaginovationOperator) 
        await Imaginovation.settlePromise(provider.address, promise.amount, promise.fee, R, promise.signature) 
 
        const beneficiaryBalance = await token.balanceOf(beneficiaries[0]) 
        beneficiaryBalance.should.be.bignumber.equal(amount) 
    }) 
 
    it('settle more than Imaginovation available balance and enable punishment mode', async () => { 
        const initialAvailableBalance = await Imaginovation.availableBalance() 
        initialAvailableBalance.should.be.bignumber.greaterThan(Zero) 
 
        const channelId = generateChannelId(provider.address, Imaginovation.address) 
        const channelState = Object.assign({}, { channelId }, await Imaginovation.channels(channelId)) 
        const amountToPay = initialAvailableBalance.add(Thousand) // promise amount should be bigger that available Imaginovation balance 
 
        // Settle promise 
        const promise = generatePromise(amountToPay, Zero, channelState, ImaginovationOperator, provider.address) 
        await Imaginovation.settlePromise(promise.identity, promise.amount, promise.fee, promise.lock, promise.signature) 
 
        // There should be zoro available Imaginovation balance 
        const availableBalance = await Imaginovation.availableBalance() 
        availableBalance.should.be.bignumber.equal(Zero) 
 
        // Because of not getting all expected balance, there should be enabled punishment mode 
        const ImaginovationStatus = await Imaginovation.getStatus() // 0 - Active, 1 - Paused, 2 - Punishment, 3 - Closed 
        expect(ImaginovationStatus.toNumber()).to.be.equal(2) 
        expect(await Imaginovation.isImaginovationActive()).to.be.false 
    }) 
 
    it('Imaginovation stake should remain untouched', async () => { 
        const ImaginovationStake = await Imaginovation.getImaginovationStake() 
        ImaginovationStake.should.be.bignumber.equal(stake) 
 
        const ImaginovationBalance = await token.balanceOf(Imaginovation.address) 
        ImaginovationBalance.should.be.bignumber.equal(await Imaginovation.minimalExpectedBalance()) 
    }) 
 
 
    // -------------- Testing punishment mode -------------- 
 
    it('should not allow to register new identity with Imaginovation in punishment mode', async () => { 
        const newProvider = wallet.generateAccount() 
        const channelStake = new BN(1000) 
 
        // Ensure that Imaginovation is in punishment mode 
        const ImaginovationStatus = await Imaginovation.getStatus() // 0 - Active, 1 - Paused, 2 - Punishment, 3 - Closed 
        expect(ImaginovationStatus.toNumber()).to.be.equal(2) 
 
        // Topup some tokens into paying channel 
        const channelAddress = await registry.getChannelAddress(newProvider.address, Imaginovation.address) 
        await topUpTokens(token, channelAddress, channelStake) 
 
        // Registering any kind of identity with Imaginovation should fail 
        let signature = signIdentityRegistration(registry.address, Imaginovation.address, channelStake, Zero, beneficiaries[1], newProvider) 
        await registry.registerIdentity(Imaginovation.address, channelStake, Zero, beneficiaries[1], signature).should.be.rejected 
 
        signature = signIdentityRegistration(registry.address, Imaginovation.address, Zero, Zero, beneficiaries[1], newProvider) 
        await registry.registerIdentity(Imaginovation.address, Zero, Zero, beneficiaries[1], signature).should.be.rejected 
    }) 
 
    it('should still allow to increase channel stake', async () => { 
        const amountToStake = new BN('1500') 
        const channelId = generateChannelId(provider.address, Imaginovation.address) 
        const initialChannelStake = (await Imaginovation.channels(channelId)).stake 
 
        // txMaker should have enough tokens 
        await topUpTokens(token, txMaker, amountToStake) 
        await token.approve(Imaginovation.address, amountToStake) 
 
        // Should increase channel stake 
        await Imaginovation.increaseStake(channelId, amountToStake) 
 
        const channel = await Imaginovation.channels(channelId) 
        channel.stake.should.be.bignumber.equal(initialChannelStake.add(amountToStake)) 
    }) 
 
    it('provider should be able to get his stake back (at least part of it)', async () => { 
        const channelId = generateChannelId(provider.address, Imaginovation.address) 
        const channelStakeAmount = (await Imaginovation.channels(channelId)).stake 
        const initialBeneficiaryBalance = await token.balanceOf(beneficiaries[0]) 
 
        const nonce = new BN(1) 
        const signature = signChannelImaginovationReturnRequest(channelId, channelStakeAmount, Zero, nonce, provider) 
        await Imaginovation.decreaseStake(provider.address, channelStakeAmount, Zero, signature) 
 
        const channel = await Imaginovation.channels(channelId) 
        const beneficiaryBalance = await token.balanceOf(beneficiaries[0]) 
        initialBeneficiaryBalance.should.be.bignumber.lessThan(beneficiaryBalance) 
        channel.stake.should.be.bignumber.lessThan(channelStakeAmount) 
    }) 
 
    it('should fail resolving emergency when txMaker balance is not enough', async () => { 
        expect(await Imaginovation.isImaginovationActive()).to.be.false 
        await Imaginovation.resolveEmergency().should.be.rejected 
    }) 
 
    it('should successfully resolve emergency', async () => { 
        expect(await Imaginovation.isImaginovationActive()).to.be.false 
 
        const initialPunishmentAmount = (await Imaginovation.punishment()).amount 
 
        // Ensure txMaker to have enough tokens to resolve emergency 
        await topUpTokens(token, txMaker, OneToken) 
        await token.approve(Imaginovation.address, OneToken) 
 
        // Wait a little 
        await sleep(1000) 
 
        await Imaginovation.resolveEmergency() 
 
        const ImaginovationStatus = await Imaginovation.getStatus() // 0 - Active, 1 - Paused, 2 - Punishment, 3 - Closed 
        expect(ImaginovationStatus.toNumber()).to.be.equal(0) 
        expect(await Imaginovation.isImaginovationActive()).to.be.true 
 
        // Because emergency was resolved fast enough, punishment amount should be not increased 
        const punishmentAmount = (await Imaginovation.punishment()).amount 
        punishmentAmount.should.be.bignumber.equal(initialPunishmentAmount) 
    }) 
 
    it('should fail calling resolveEmergency() when not in punishment mode', async () => { 
        expect(await Imaginovation.isImaginovationActive()).to.be.true 
        await Imaginovation.resolveEmergency().should.be.rejected 
    }) 
 
    it('should all back to normal', async () => { 
        // Should allow to register new identity 
        const newProvider = wallet.generateAccount() 
        const channelStake = new BN(1000) 
 
        const channelAddress = await registry.getChannelAddress(newProvider.address, Imaginovation.address) 
        await topUpTokens(token, channelAddress, channelStake) 
 
        let signature = signIdentityRegistration(registry.address, Imaginovation.address, channelStake, Zero, beneficiaries[1], newProvider) 
        await registry.registerIdentity(Imaginovation.address, channelStake, Zero, beneficiaries[1], signature) 
 
        // Ensure that Imaginovation has enough funds 
        await topUpTokens(token, Imaginovation.address, OneToken) 
 
        // Should be able to settle promise 
        const channelId = generateChannelId(newProvider.address, Imaginovation.address) 
        const R = randomBytes(32) 
        const hashlock = keccak(R) 
        const promiseAmount = channelStake 
 
        const promise = createPromise(ChainID, channelId, promiseAmount, Zero, hashlock, ImaginovationOperator) 
        await Imaginovation.settlePromise(newProvider.address, promise.amount, promise.fee, R, promise.signature) 
 
        expect(await Imaginovation.isImaginovationActive()).to.be.true 
    }) 
 
    it('should enable punishment mode again', async () => { 
        const channelId = generateChannelId(provider.address, Imaginovation.address) 
 
        // Withdraw available balance 
        const availableBalance = await Imaginovation.availableBalance() 
        await Imaginovation.withdraw(beneficiaries[3], availableBalance, { from: operatorAddress }) 
 
        // Ensure channel's stake 
        const amount = new BN(1000) 
        await topUpTokens(token, txMaker, amount) 
        await token.approve(Imaginovation.address, amount) 
        await Imaginovation.increaseStake(channelId, amount, { from: txMaker }) 
 
        // Create and settle promise 
        const channelState = Object.assign({}, { channelId }, await Imaginovation.channels(channelId)) 
        const promise = generatePromise(amount, Zero, channelState, ImaginovationOperator, provider.address) 
        await Imaginovation.settlePromise(promise.identity, promise.amount, promise.fee, promise.lock, promise.signature) 
 
        // Status should be in punishment mode 
        const ImaginovationStatus = await Imaginovation.getStatus() // 0 - Active, 1 - Paused, 2 - Punishment, 3 - Closed 
        expect(ImaginovationStatus.toNumber()).to.be.equal(2) 
        expect(await Imaginovation.isImaginovationActive()).to.be.false 
    }) 
 
    it('should be not possible to close Imaginovation while in punishment mode', async () => { 
        expect((await Imaginovation.getStatus()).toNumber()).to.be.equal(2)  // 0 - Active, 1 - Paused, 2 - Punishment, 3 - Closed 
        await Imaginovation.closeImaginovation({ from: operatorAddress }).should.be.rejected 
    }) 
 
    it('Imaginovation should be punished for not resolving emergency on time', async () => { 
        const totalStake = await Imaginovation.getTotalStake() 
 
        // Move blockchain forward 
        await sleep(4500) // a little more than 2 units of time 
        await Imaginovation.moveBlock() 
 
        // Topup tokens into txMaker and approve Imaginovation to use them during resolveEmergency call. 
        await topUpTokens(token, txMaker, OneToken, { from: txMaker }) 
        await token.approve(Imaginovation.address, OneToken) 
 
        await Imaginovation.resolveEmergency() 
 
        const ImaginovationStatus = await Imaginovation.getStatus() // 0 - Active, 1 - Paused, 2 - Punishment, 3 - Closed 
        expect(ImaginovationStatus.toNumber()).to.be.equal(0) 
 
        // Emergency was resolved after 10 blocks (within 2 unit of time), 
        // punishment amount should be 0.08% of locked in channels funds. 
        const expectedPunishment = totalStake * 0.04 * 2 
        const punishmentAmount = (await Imaginovation.punishment()).amount.toNumber() 
        expect(punishmentAmount).to.be.equal(expectedPunishment) 
 
        expect(await Imaginovation.isImaginovationActive()).to.be.true 
    }) 
 
}) 
