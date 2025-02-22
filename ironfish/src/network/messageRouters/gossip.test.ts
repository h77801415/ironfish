/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

jest.mock('uuid')
jest.mock('ws')

import { mocked } from 'ts-jest/utils'
import { v4 as uuid } from 'uuid'
import ws from 'ws'
import { PeerNetwork, RoutingStyle } from '../peerNetwork'
import { GossipRouter } from './gossip'
import { PeerManager } from '../peers/peerManager'
import { mockLocalPeer, getConnectedPeer } from '../testUtilities'
import { mockChain, mockNode, mockStrategy } from '../../testUtilities/mocks'

jest.useFakeTimers()

describe('Gossip Router', () => {
  it('Broadcasts a message on gossip', () => {
    mocked(uuid).mockReturnValue('test_broadcast')
    const pm = new PeerManager(mockLocalPeer())
    const broadcastMock = jest.spyOn(pm, 'broadcast').mockImplementation(() => {})
    const router = new GossipRouter(pm)
    router.register('test', jest.fn())
    const message = { type: 'test', payload: { test: 'hi payload' } }
    router.gossip(message)
    expect(uuid).toBeCalledTimes(1)
    expect(broadcastMock).toBeCalledTimes(1)
    expect(broadcastMock).toBeCalledWith({ ...message, nonce: 'test_broadcast' })
  })

  it('Handles an incoming gossip message', async () => {
    const pm = new PeerManager(mockLocalPeer())
    const broadcastMock = jest.spyOn(pm, 'broadcast').mockImplementation(() => {})
    const { peer: peer1 } = getConnectedPeer(pm)
    const { peer: peer2 } = getConnectedPeer(pm)
    const peer1Spy = jest.spyOn(peer1, 'send')
    const peer2Spy = jest.spyOn(peer2, 'send')

    const router = new GossipRouter(pm)
    router.register('test', () => Promise.resolve())
    const message = { type: 'test', nonce: 'test_handler1', payload: { test: 'payload' } }
    await router.handle(peer1, message)

    expect(broadcastMock).not.toBeCalled()
    // Should not send the message back to the peer it received it from
    expect(peer1Spy).not.toBeCalled()
    expect(peer2Spy).toBeCalledTimes(1)
    expect(peer2Spy).toBeCalledWith(message)
  })

  it('Does not process a seen message twice', async () => {
    const pm = new PeerManager(mockLocalPeer())
    const broadcastMock = jest.spyOn(pm, 'broadcast').mockImplementation(() => {})
    const { peer: peer1 } = getConnectedPeer(pm)
    const { peer: peer2 } = getConnectedPeer(pm)
    const peer1Spy = jest.spyOn(peer1, 'send')
    const peer2Spy = jest.spyOn(peer2, 'send')

    const router = new GossipRouter(pm)
    router.register('test', () => Promise.resolve())
    const message = { type: 'test', nonce: 'test_handler1', payload: { test: 'payload' } }
    // Should send the message to peer2
    await router.handle(peer1, message)

    expect(broadcastMock).not.toBeCalled()
    // Should not send the message back to the peer it received it from
    expect(peer1Spy).not.toBeCalled()
    expect(peer2Spy).toBeCalledTimes(1)
    expect(peer2Spy).toBeCalledWith(message)

    peer1Spy.mockClear()
    peer2Spy.mockClear()

    await router.handle(peer1, message)
    await router.handle(peer2, message)

    expect(peer1Spy).not.toBeCalled()
    expect(peer2Spy).not.toBeCalled()
  })

  it('Does not send messages to peers of peer that sent it', async () => {
    const pm = new PeerManager(mockLocalPeer())
    const broadcastMock = jest.spyOn(pm, 'broadcast').mockImplementation(() => {})
    const { peer: peer1 } = getConnectedPeer(pm)
    const { peer: peer2 } = getConnectedPeer(pm)
    const { peer: peer3 } = getConnectedPeer(pm)
    const peer1Spy = jest.spyOn(peer1, 'send')
    const peer2Spy = jest.spyOn(peer2, 'send')
    const peer3Spy = jest.spyOn(peer3, 'send')

    peer1.knownPeers.set(peer2.getIdentityOrThrow(), peer2)
    peer2.knownPeers.set(peer1.getIdentityOrThrow(), peer1)

    const router = new GossipRouter(pm)
    router.register('test', () => Promise.resolve())
    const message = { type: 'test', nonce: 'test_double', payload: { test: 'payload' } }
    await router.handle(peer1, message)
    expect(broadcastMock).not.toBeCalled()
    expect(peer1Spy).not.toBeCalled()
    expect(peer2Spy).not.toBeCalled()
    expect(peer3Spy).toBeCalledTimes(1)
    expect(peer3Spy).toBeCalledWith(message)
  })

  it('routes a gossip message as gossip', async () => {
    const network = new PeerNetwork({
      agent: 'sdk/1/cli',
      webSocket: ws,
      node: mockNode(),
      chain: mockChain(),
      strategy: mockStrategy(),
    })

    const gossipMock = jest.fn(async () => {})
    network['gossipRouter'].handle = gossipMock
    network.registerHandler(
      'hello',
      RoutingStyle.gossip,
      () => Promise.resolve({ name: '' }),
      () => {},
    )
    const pm = new PeerManager(mockLocalPeer())
    const { peer } = getConnectedPeer(pm)
    const message = { type: 'hello', nonce: 'test_handler1', payload: { test: 'payload' } }
    await network['handleMessage'](peer, { peerIdentity: peer.getIdentityOrThrow(), message })
    expect(gossipMock).toBeCalled()
    network.stop()
  })

  it('does not handle a poorly formatted gossip message as gossip', async () => {
    const network = new PeerNetwork({
      agent: 'sdk/1/cli',
      webSocket: ws,
      node: mockNode(),
      chain: mockChain(),
      strategy: mockStrategy(),
    })

    const gossipMock = jest.fn(async () => {})
    network['gossipRouter'].handle = gossipMock

    network.registerHandler(
      'hello',
      RoutingStyle.gossip,
      jest.fn((p) => Promise.resolve(p)),
      () => {},
    )
    const logFn = jest.fn()
    network['logger'].mock(() => logFn)

    const pm = new PeerManager(mockLocalPeer())
    const { peer } = getConnectedPeer(pm)

    // This is the wrong type so it tests that it fails
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const message = { type: 'test', test: 'payload' } as any

    await network['handleMessage'](peer, {
      peerIdentity: peer.getIdentityOrThrow(),
      message: message,
    })

    expect(gossipMock).not.toBeCalled()
    expect(logFn).toBeCalled()
    network.stop()
  })
})
