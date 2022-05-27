require('chai') 
    .use(require('chai-as-promised')) 
    .should() 
const {BN} = require('web3-utils') 
const { topUpTokens, setupDEX } = require('./utils/index.js') 
const { signIdentityRegistration } = require('./utils/client.js') 
const wallet = require('./utils/wallet.js') 
 
const MystToken = artifacts.require("TestMystToken") 
const Registry = artifacts.require("Registry") 
const ImaginovationImplementation = artifacts.require("ImaginovationImplementation") 
const ChannelImplementation = artifacts.require("ChannelImplementation") 
 
const ZeroAddress = '0x0000000000000000000000000000000000000000' 
const Zero = new BN(0) 
const OneToken = web3.utils.toWei(new BN('100000000'), 'wei') 
const ImaginovationURL = Buffer.from('http://test.Imaginovation') 
 
// Generate private keys for Imaginovation operators 
const operators = [ 
    wallet.generateAccount(), 
    wallet.generateAccount(), 
    wallet.generateAccount() 
] 
 
const identity = wallet.generateAccount() 
 
contract('Multi Imaginovationes', ([txMaker, ...beneficiaries]) => { 
    let token, channelImplementation, Imaginovationes, dex, registry 
    before(async () => { 
        token = await MystToken.new() 
        dex = await setupDEX(token, txMaker) 
        const ImaginovationImplementation = await ImaginovationImplementation.new() 
        channelImplementation = await ChannelImplementation.new() 
        registry = await Registry.new() 
        await registry.initialize(token.address, dex.address, 0, channelImplementation.address, ImaginovationImplementation.address, ZeroAddress) 
 
        // Topup some tokens into txMaker address so it could register Imaginovationes 
        await topUpTokens(token, txMaker, 1000) 
        await token.approve(registry.address, 1000) 
    }) 
 
    it('should register Imaginovationes', async () => { 
        Imaginovationes = [] 
        for (const operator of operators) { 
            await registry.registerImaginovation(operator.address, 10, 0, 25, OneToken, ImaginovationURL) 
            const id = await registry.getImaginovationAddress(operator.address) 
            Imaginovationes.push({ id, operator }) 
            expect(await registry.isImaginovation(id)).to.be.true 
        } 
    }) 
 
    it('should register consumer identity', async () => { 
        const ImaginovationId = Imaginovationes[0].id 
        const signature = signIdentityRegistration(registry.address, ImaginovationId, Zero, Zero, beneficiaries[0], identity) 
        await registry.registerIdentity(ImaginovationId, Zero, Zero, beneficiaries[0], signature) 
        expect(await registry.isRegistered(identity.address)).to.be.true 
 
        const channel = await ChannelImplementation.at(await registry.getChannelAddress(identity.address, ImaginovationId)) 
        expect((await channel.Imaginovation()).contractAddress).to.be.equal(ImaginovationId) 
    }) 
 
 
    it('should register consumer channel with second Imaginovation', async () => { 
        const ImaginovationId = Imaginovationes[1].id 
        expect(await registry.isRegistered(identity.address)).to.be.true 
 
        const signature = signIdentityRegistration(registry.address, ImaginovationId, Zero, Zero, beneficiaries[0], identity) 
        await registry.registerIdentity(ImaginovationId, Zero, Zero, beneficiaries[0], signature) 
 
        const channel = await ChannelImplementation.at(await registry.getChannelAddress(identity.address, ImaginovationId)) 
        expect((await channel.Imaginovation()).contractAddress).to.be.equal(ImaginovationId) 
    }) 
 
    it('should fail registering consumer channel with same Imaginovation twice', async () => { 
        const ImaginovationId = Imaginovationes[1].id 
        expect(await registry.isRegistered(identity.address)).to.be.true 
 
        const signature = signIdentityRegistration(registry.address, ImaginovationId, Zero, Zero, beneficiaries[0], identity) 
        await registry.registerIdentity(ImaginovationId, Zero, Zero, beneficiaries[0], signature).should.be.rejected 
    }) 
}) 
