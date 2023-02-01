import type { Connection, Stream } from '@libp2p/interface-connection'
import { mockConnection, mockDuplex, mockMultiaddrConnection, mockStream } from '@libp2p/interface-mocks'
import type { PeerId } from '@libp2p/interface-peer-id'
import { expect } from 'aegir/chai'
import { pair } from 'it-pair'
import * as sinon from 'sinon'
import { Circuit } from '../../../src/circuit/transport.js'
import { handleHopProtocol } from '../../../src/circuit/v2/hop.js'
import { HopMessage, Status, StopMessage } from '../../../src/circuit/v2/pb/index.js'
import { ReservationStore } from '../../../src/circuit/v2/reservation-store.js'
import { Components, DefaultComponents } from '../../../src/components.js'
import { DefaultConnectionManager } from '../../../src/connection-manager/index.js'
import { DefaultRegistrar } from '../../../src/registrar.js'
import { DefaultUpgrader } from '../../../src/upgrader.js'
import * as peerUtils from '../../utils/creators/peer.js'
import * as Constants from '../../../src/constants.js'
import { dnsaddrResolver } from '@multiformats/multiaddr/resolvers'
import { publicAddressesFirst } from '@libp2p/utils/address-sort'
import { PersistentPeerStore } from '@libp2p/peer-store'
import { multiaddr } from '@multiformats/multiaddr'
import type { AclStatus } from '../../../src/circuit/v2/interfaces.js'
import { pbStream } from 'it-pb-stream'

/* eslint-env mocha */

describe('Circuit v2 - hop protocol', function () {
  describe('reserve', function () {
    let relayPeer: PeerId, conn: Connection, stream: Stream, reservationStore: ReservationStore

    beforeEach(async () => {
      [, relayPeer] = await peerUtils.createPeerIds(2)
      conn = mockConnection(mockMultiaddrConnection(mockDuplex(), relayPeer))
      stream = mockStream(pair<any>())
      reservationStore = new ReservationStore()
    })

    this.afterEach(async function () {
      await conn.close()
    })

    it('error on unknown message type', async function () {
      const stream = mockStream(pair<any>())
      const pbstr = pbStream(stream)
      await handleHopProtocol({
        connection: mockConnection(mockMultiaddrConnection(mockDuplex(), await peerUtils.createPeerId())),
        pbstr,
        request: {},
        relayPeer,
        relayAddrs: [],
        reservationStore,
        connectionManager: sinon.stub() as any
      })
      const msg = await pbstr.pb(HopMessage).read()
      expect(msg.type).to.be.equal(HopMessage.Type.STATUS)
      expect(msg.status).to.be.equal(Status.UNEXPECTED_MESSAGE)
    })

    it('should reserve slot', async function () {
      const expire: number = 123
      const reserveStub = sinon.stub(reservationStore, 'reserve')
      reserveStub.resolves({ status: Status.OK, expire })
      const pbstr = pbStream(stream)
      await handleHopProtocol({
        request: {
          type: HopMessage.Type.RESERVE
        },
        connection: conn,
        pbstr,
        relayPeer,
        connectionManager: sinon.stub() as any,
        relayAddrs: [multiaddr('/ip4/127.0.0.1/udp/1234')],
        reservationStore
      })
      expect(reserveStub.calledOnceWith(conn.remotePeer, conn.remoteAddr)).to.be.true()
      const response = await pbstr.pb(HopMessage).read()
      expect(response.type).to.be.equal(HopMessage.Type.STATUS)
      expect(response.limit).to.be.undefined()
      expect(response.status).to.be.equal(Status.OK)
      expect(response.reservation?.expire).to.be.equal(BigInt(expire))
      expect(response.reservation?.voucher).to.not.be.undefined()
      expect(response.reservation?.addrs?.length).to.be.greaterThan(0)
    })

    it('should fail to reserve slot - acl denied', async function () {
      const reserveStub = sinon.stub(reservationStore, 'reserve')
      const pbstr = pbStream(stream)
      await handleHopProtocol({
        request: {
          type: HopMessage.Type.RESERVE
        },
        connection: conn,
        pbstr,
        relayPeer,
        connectionManager: sinon.stub() as any,
        relayAddrs: [multiaddr('/ip4/127.0.0.1/udp/1234')],
        reservationStore,
        acl: { allowReserve: async function () { return false }, allowConnect: sinon.stub() as any }
      })
      expect(reserveStub.notCalled).to.be.true()
      const response = await pbstr.pb(HopMessage).read()
      expect(response.type).to.be.equal(HopMessage.Type.STATUS)
      expect(response.limit).to.be.undefined()
      expect(response.status).to.be.equal(Status.PERMISSION_DENIED)
    })

    it('should fail to reserve slot - resource exceeded', async function () {
      const reserveStub = sinon.stub(reservationStore, 'reserve')
      reserveStub.resolves({ status: Status.RESERVATION_REFUSED })
      const pbstr = pbStream(stream)
      await handleHopProtocol({
        request: {
          type: HopMessage.Type.RESERVE
        },
        connection: conn,
        pbstr,
        relayPeer,
        connectionManager: sinon.stub() as any,
        relayAddrs: [multiaddr('/ip4/127.0.0.1/udp/1234')],
        reservationStore
      })
      expect(reserveStub.calledOnce).to.be.true()
      const response = await pbstr.pb(HopMessage).read()
      expect(response.type).to.be.equal(HopMessage.Type.STATUS)
      expect(response.limit).to.be.undefined()
      expect(response.status).to.be.equal(Status.RESERVATION_REFUSED)
    })

    it('should fail to reserve slot - failed to write response', async function () {
      const reserveStub = sinon.stub(reservationStore, 'reserve')
      const removeReservationStub = sinon.stub(reservationStore, 'removeReservation')
      reserveStub.resolves({ status: Status.OK, expire: 123 })
      removeReservationStub.resolves()
      const pbstr = pbStream(stream)
      const backup = pbstr.write
      pbstr.write = function () { throw new Error('connection reset') }
      await handleHopProtocol({
        request: {
          type: HopMessage.Type.RESERVE
        },
        connection: conn,
        pbstr,
        relayPeer,
        connectionManager: sinon.stub() as any,
        relayAddrs: [multiaddr('/ip4/127.0.0.1/udp/1234')],
        reservationStore
      })
      expect(reserveStub.calledOnce).to.be.true()
      expect(removeReservationStub.calledOnce).to.be.true()
      pbstr.write = backup
    })
  })

  describe('connect', function () {
    let relayPeer: PeerId, dstPeer: PeerId, conn: Connection, stream: Stream, reservationStore: ReservationStore,
      circuit: Circuit, components: Components

    beforeEach(async () => {
      [, relayPeer, dstPeer] = await peerUtils.createPeerIds(3)
      conn = mockConnection(mockMultiaddrConnection(mockDuplex(), relayPeer))
      stream = mockStream(pair<any>())
      reservationStore = new ReservationStore()
      // components
      components = new DefaultComponents()
      components.connectionManager = new DefaultConnectionManager(components,

        {
          maxConnections: 300,
          minConnections: 50,
          autoDial: true,
          autoDialInterval: 10000,
          maxParallelDials: Constants.MAX_PARALLEL_DIALS,
          maxDialsPerPeer: Constants.MAX_PER_PEER_DIALS,
          dialTimeout: Constants.DIAL_TIMEOUT,
          inboundUpgradeTimeout: Constants.INBOUND_UPGRADE_TIMEOUT,
          resolvers: {
            dnsaddr: dnsaddrResolver
          },
          addressSorter: publicAddressesFirst
        }
      )
      components.peerStore = new PersistentPeerStore(components)
      components.registrar = new DefaultRegistrar(components)
      components.upgrader = new DefaultUpgrader(components, {
        connectionEncryption: [],
        muxers: [],
        inboundUpgradeTimeout: 10000
      })

      circuit = new Circuit(components, {
        enabled: true,
        advertise: {
          enabled: false
        },
        hop: {
          enabled: true,
          timeout: 30000
        },
        reservationManager: {
          enabled: false,
          maxReservations: 2
        }
      })
    })

    this.afterEach(async function () {
      await conn.close()
    })

    it('should succeed to connect', async function () {
      const hasReservationStub = sinon.stub(reservationStore, 'hasReservation')
      hasReservationStub.resolves(true)
      const dstConn = mockConnection(
        mockMultiaddrConnection(pair<Uint8Array>(), dstPeer)
      )
      const streamStub = sinon.stub(dstConn, 'newStream')
      const dstStream = mockStream(pair<any>())
      streamStub.resolves(dstStream)
      const dstStreamHandler = pbStream(dstStream)
      dstStreamHandler.pb(StopMessage).write({
        type: StopMessage.Type.STATUS,
        status: Status.OK
      })
      const pbstr = pbStream(stream)
      const stub = sinon.stub(components.connectionManager, 'getConnections')
      stub.returns([dstConn])
      await handleHopProtocol({
        connection: conn,
        pbstr,
        request: {
          type: HopMessage.Type.CONNECT,
          peer: {
            id: dstPeer.toBytes(),
            addrs: []
          }
        },
        relayPeer: relayPeer,
        relayAddrs: [],
        reservationStore,
        connectionManager: components.connectionManager
      })
      const response = await pbstr.pb(HopMessage).read()
      expect(response.type).to.be.equal(HopMessage.Type.STATUS)
      expect(response.status).to.be.equal(Status.OK)
    })

    it('should fail to connect - invalid request', async function () {
      const pbstr = pbStream(stream)
      await handleHopProtocol({
        connection: conn,
        pbstr: pbstr,
        request: {
          type: HopMessage.Type.CONNECT,
          // @ts-expect-error {} is missing the following properties from peer: id, addrs
          peer: {}
        },
        reservationStore,
        circuit
      })
      const response = await pbstr.pb(HopMessage).read()
      expect(response.type).to.be.equal(HopMessage.Type.STATUS)
      expect(response.status).to.be.equal(Status.MALFORMED_MESSAGE)
    })

    it('should failed to connect - acl denied', async function () {
      const pbstr = pbStream(stream)
      const acl = {
        allowConnect: async () => await Promise.resolve(Status.PERMISSION_DENIED as AclStatus),
        allowReserve: async () => await Promise.resolve(false)
      }
      await handleHopProtocol({
        connection: conn,
        pbstr,
        request: {
          type: HopMessage.Type.CONNECT,
          peer: {
            id: dstPeer.toBytes(),
            addrs: []
          }
        },
        relayPeer: relayPeer,
        relayAddrs: [],
        reservationStore,
        connectionManager: components.connectionManager,
        acl
      })
      const response = await pbstr.pb(HopMessage).read()
      expect(response.type).to.be.equal(HopMessage.Type.STATUS)
      expect(response.status).to.be.equal(Status.PERMISSION_DENIED)
    })

    it('should fail to connect - no reservation', async function () {
      const hasReservationStub = sinon.stub(reservationStore, 'hasReservation')
      hasReservationStub.resolves(false)
      const pbstr = pbStream(stream)
      await handleHopProtocol({
        connection: conn,
        pbstr,
        request: {
          type: HopMessage.Type.CONNECT,
          peer: {
            id: dstPeer.toBytes(),
            addrs: []
          }
        },
        relayPeer: relayPeer,
        relayAddrs: [],
        reservationStore,
        connectionManager: components.connectionManager
      })
      const response = await pbstr.pb(HopMessage).read()
      expect(response.type).to.be.equal(HopMessage.Type.STATUS)
      expect(response.status).to.be.equal(Status.NO_RESERVATION)
    })

    it('should fail to connect - no connection', async function () {
      const hasReservationStub = sinon.stub(reservationStore, 'hasReservation')
      hasReservationStub.resolves(true)
      const stub = sinon.stub(components.connectionManager, 'getConnections')
      stub.returns([])
      const pbstr = pbStream(stream)
      await handleHopProtocol({
        connection: conn,
        pbstr,
        request: {
          type: HopMessage.Type.CONNECT,
          peer: {
            id: dstPeer.toBytes(),
            addrs: []
          }
        },
        relayPeer: relayPeer,
        relayAddrs: [],
        reservationStore,
        connectionManager: components.connectionManager
      })
      const response = await pbstr.pb(HopMessage).read()
      expect(response.type).to.be.equal(HopMessage.Type.STATUS)
      expect(response.status).to.be.equal(Status.NO_RESERVATION)
      expect(stub.calledOnce).to.be.true()
    })
  })
})