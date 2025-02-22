/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import tweetnacl from 'tweetnacl'
import { createRootLogger, Logger } from '../logger'
import { MetricsMonitor } from '../metrics'
import { PeerConnectionManager } from './peers/peerConnectionManager'
import { PeerManager } from './peers/peerManager'
import { PrivateIdentity } from './identity'
import { WebSocketServer } from './webSocketServer'
import { Event } from '../event'
import {
  MessageType,
  IncomingPeerMessage,
  Message,
  PayloadType,
  LooseMessage,
  InternalMessageType,
  DisconnectingMessage,
  DisconnectingReason,
  BlockRequestMessage,
  BlocksResponseMessage,
  BlockRequest,
  NewBlockMessage,
  NodeMessageType,
  isBlockRequestPayload,
  isBlocksResponse,
  NewTransactionMessage,
} from './messages'
import { IsomorphicWebRtc, IsomorphicWebSocketConstructor } from './types'
import {
  FireAndForgetRouter,
  GlobalRpcRouter,
  GossipRouter,
  Gossip,
  isGossip,
  RpcRouter,
  IncomingRpcGeneric,
  isRpc,
  Rpc,
} from './messageRouters'
import { Peer } from './peers/peer'
import { LocalPeer } from './peers/localPeer'
import { Identity } from './identity'
import { parseUrl } from './utils/parseUrl'
import { DEFAULT_WEBSOCKET_PORT } from '../fileStores/config'
import { IronfishNode } from '../node'
import { NetworkBlockType } from '../blockSyncer'
import { IronfishStrategy } from '../strategy'
import { IronfishBlockchain } from '../blockchain'
import { SerializedWasmNoteEncrypted } from '../primitives/noteEncrypted'
import { SerializedTransaction } from '../primitives/transaction'
import { BlockHashSerdeInstance } from '../serde'

/**
 * The routing style that should be used for a message of a given type
 */
export enum RoutingStyle {
  gossip = 'gossip',
  directRPC = 'directRPC',
  globalRPC = 'globalRPC',
  fireAndForget = 'fireAndForget',
}

interface RouteMap<T extends MessageType, P extends PayloadType> {
  [RoutingStyle.gossip]: Gossip<T, P>
  [RoutingStyle.globalRPC]: Rpc<T, P>
  [RoutingStyle.directRPC]: Rpc<T, P>
  [RoutingStyle.fireAndForget]: Message<T, P>
}

interface ReturnMap {
  [RoutingStyle.gossip]: void
  [RoutingStyle.globalRPC]: Promise<PayloadType>
  [RoutingStyle.directRPC]: Promise<PayloadType>
  [RoutingStyle.fireAndForget]: void
}

/**
 * Entry point for the peer-to-peer network. Manages connections to other peers on the network
 * and provides abstractions for several methods of sending/receiving network messages.
 */
export class PeerNetwork {
  // optional WebSocket server, started from Node.JS
  private webSocketServer?: WebSocketServer

  readonly localPeer: LocalPeer
  readonly peerManager: PeerManager
  readonly onIsReadyChanged = new Event<[boolean]>()

  private started = false
  private readonly minPeers: number
  private readonly bootstrapNodes: string[]
  private readonly listen: boolean
  private readonly peerConnectionManager: PeerConnectionManager
  private readonly routingStyles: Map<MessageType, RoutingStyle>
  private readonly gossipRouter: GossipRouter
  private readonly fireAndForgetRouter: FireAndForgetRouter
  private readonly directRpcRouter: RpcRouter
  private readonly globalRpcRouter: GlobalRpcRouter
  private readonly logger: Logger
  private readonly metrics: MetricsMonitor
  private readonly node: IronfishNode
  private readonly strategy: IronfishStrategy
  private readonly chain: IronfishBlockchain

  /**
   * If the peer network is ready for messages to be sent or not
   */
  private _isReady = false
  get isReady(): boolean {
    return this._isReady
  }

  constructor(options: {
    identity?: PrivateIdentity
    agent: string
    webSocket: IsomorphicWebSocketConstructor
    webRtc?: IsomorphicWebRtc
    listen?: boolean
    port?: number
    bootstrapNodes?: string[]
    name?: string | null
    maxPeers?: number
    minPeers?: number
    targetPeers?: number
    enableSyncing?: boolean
    isWorker?: boolean
    broadcastWorkers?: boolean
    simulateLatency?: number
    logger?: Logger
    metrics?: MetricsMonitor
    node: IronfishNode
    strategy: IronfishStrategy
    chain: IronfishBlockchain
  }) {
    const identity = options.identity || tweetnacl.box.keyPair()
    const enableSyncing = options.enableSyncing ?? true

    this.node = options.node
    this.chain = options.chain
    this.strategy = options.strategy
    this.logger = (options.logger || createRootLogger()).withTag('peernetwork')
    this.metrics = options.metrics || new MetricsMonitor(this.logger)
    this.bootstrapNodes = options.bootstrapNodes || []

    this.localPeer = new LocalPeer(identity, options.agent, options.webSocket, options.webRtc)
    this.localPeer.port = options.port === undefined ? null : options.port
    this.localPeer.name = options.name || null
    this.localPeer.isWorker = options.isWorker || false
    this.localPeer.simulateLatency = options.simulateLatency || 0
    this.localPeer.broadcastWorkers =
      options.broadcastWorkers === undefined ? true : options.broadcastWorkers

    const maxPeers = options.maxPeers || 10000
    const targetPeers = options.targetPeers || 50

    this.peerManager = new PeerManager(
      this.localPeer,
      this.logger,
      this.metrics,
      maxPeers,
      targetPeers,
    )
    this.peerManager.onMessage.on((peer, message) => this.handleMessage(peer, message))
    this.peerManager.onConnectedPeersChanged.on(() => this.updateIsReady())

    this.peerConnectionManager = new PeerConnectionManager(this.peerManager, this.logger, {
      maxPeers,
    })

    this.routingStyles = new Map<MessageType, RoutingStyle>()
    this.gossipRouter = new GossipRouter(this.peerManager)
    this.fireAndForgetRouter = new FireAndForgetRouter(this.peerManager)
    this.directRpcRouter = new RpcRouter(this.peerManager)
    this.globalRpcRouter = new GlobalRpcRouter(this.directRpcRouter)

    this.minPeers = options.minPeers || 1
    this.listen = options.listen === undefined ? true : options.listen

    if (options.name && options.name.length > 32) {
      options.name = options.name.slice(32)
    }

    this.registerHandler(
      NodeMessageType.Blocks,
      RoutingStyle.globalRPC,
      (p) => {
        return isBlockRequestPayload(p) ? Promise.resolve(p) : Promise.reject('Invalid format')
      },
      (message) => this.onBlockRequest(message),
    )

    if (enableSyncing) {
      this.registerHandler(
        NodeMessageType.NewBlock,
        RoutingStyle.gossip,
        (p) => {
          return this.chain.verifier.verifyNewBlock(p, this.node.workerPool)
        },
        (message) => this.onNewBlock(message),
      )

      this.registerHandler(
        NodeMessageType.NewTransaction,
        RoutingStyle.gossip,
        (p) => {
          return this.chain.verifier.verifyNewTransaction(p)
        },
        async (message) => await this.onNewTransaction(message),
      )
    } else {
      this.registerHandler(
        NodeMessageType.NewBlock,
        RoutingStyle.gossip,
        () => Promise.resolve(undefined),
        () => Promise.resolve(undefined),
      )
      this.registerHandler(
        NodeMessageType.NewTransaction,
        RoutingStyle.gossip,
        () => Promise.resolve(undefined),
        () => Promise.resolve(undefined),
      )
    }

    this.node.miningDirector.onNewBlock.on((block) => {
      const serializedBlock = this.strategy.blockSerde.serialize(block)

      this.gossip({
        type: NodeMessageType.NewBlock,
        payload: {
          block: serializedBlock,
        },
      })
    })

    this.node.accounts.onBroadcastTransaction.on((transaction) => {
      const serializedTransaction = this.strategy.transactionSerde().serialize(transaction)

      this.gossip({
        type: NodeMessageType.NewTransaction,
        payload: { transaction: serializedTransaction },
      })
    })
  }

  /** Used to request a block by header hash or sequence */
  requestBlocks(hash: Buffer, nextBlockDirection: boolean, peer?: Identity): void {
    const serializedHash = BlockHashSerdeInstance.serialize(hash)

    const request: BlockRequest = {
      type: NodeMessageType.Blocks,
      payload: {
        hash: serializedHash,
        nextBlockDirection: nextBlockDirection,
      },
    }

    this.request(request, peer)
      .then((c) => {
        if (
          !c ||
          !isBlocksResponse<SerializedWasmNoteEncrypted, SerializedTransaction>(c.message)
        ) {
          throw new Error('Invalid format')
        }
        this.onBlockResponses(
          {
            ...c,
            message: c.message,
          },
          request,
        )
      })
      .catch((err) => {
        this.node.syncer.handleBlockRequestError(request, err)
      })
  }

  start(): void {
    if (this.started) return
    this.started = true

    // Start the WebSocket server if possible
    if (this.listen && 'Server' in this.localPeer.webSocket && this.localPeer.port != null) {
      this.webSocketServer = new WebSocketServer(
        this.localPeer.webSocket.Server,
        this.localPeer.port,
      )

      this.webSocketServer.onStart(() => {
        const address = this.webSocketServer?.server.address()
        const addressStr =
          typeof address === 'object' ? `${address.address}:${address.port}` : String(address)
        this.logger.info(`WebSocket server started at ${addressStr}`)
      })

      this.webSocketServer.onConnection((connection, req) => {
        let address: string | null = null

        if (this.peerManager.shouldRejectDisconnectedPeers()) {
          this.logger.debug(
            'Disconnecting inbound websocket connection because the node has max peers',
          )

          const disconnect: DisconnectingMessage = {
            type: InternalMessageType.disconnecting,
            payload: {
              sourceIdentity: this.localPeer.publicIdentity,
              destinationIdentity: null,
              reason: DisconnectingReason.Congested,
              disconnectUntil: Date.now() + 1000 * 60 * 5,
            },
          }
          connection.send(JSON.stringify(disconnect))
          connection.close()
          return
        }

        if (req.headers['X-Forwarded-For'] && req.headers['X-Forwarded-For'][0]) {
          address = req.headers['X-Forwarded-For'][0]
        } else if (req.socket.remoteAddress) {
          address = req.socket.remoteAddress
        }

        if (address) {
          // Some times local peers connect on IPV6 incompatible addresses like
          // '::ffff:127.0.0.1' and we don't support connecting over IPv6 right now
          address = address.replace('::ffff:', '')
        }

        this.peerManager.createPeerFromInboundWebSocketConnection(connection, address)
      })

      this.peerManager.onConnect.on((peer: Peer) => {
        this.logger.debug(`Connected to ${peer.getIdentityOrThrow()}`)
      })

      this.peerManager.onDisconnect.on((peer: Peer) => {
        this.logger.debug(`Disconnected from ${String(peer.state.identity)}`)
      })

      this.onIsReadyChanged.on((isReady: boolean) => {
        if (isReady) {
          this.logger.info(`Connected to the Iron Fish network`)
          this.node.onPeerNetworkReady()
        } else {
          this.logger.info(`Not connected to the Iron Fish network`)
          this.node.onPeerNetworkNotReady()
        }
      })
    }

    // Start up the PeerManager
    this.peerManager.start()

    // Start up the PeerConnectionManager
    this.peerConnectionManager.start()

    this.updateIsReady()

    for (const node of this.bootstrapNodes) {
      const url = parseUrl(node)

      if (!url.hostname) {
        throw new Error(
          `Could not determine a hostname for bootstrap node "${node}". Is it formatted correctly?`,
        )
      }

      // If the user has not specified a port, we can guess that
      // it's running on the default ironfish websocket port
      const port = url.port ? url.port : DEFAULT_WEBSOCKET_PORT
      const address = url.hostname + `:${port}`
      this.peerManager.connectToWebSocketAddress(address, true)
    }
  }

  /**
   * Call close when shutting down the PeerNetwork to clean up
   * outstanding connections.
   */
  stop(): void {
    this.started = false
    this.peerConnectionManager.stop()
    this.peerManager.stop()
    this.webSocketServer?.close()
    this.updateIsReady()
  }

  /**
   * Register a handler as being the processor for a specific message type.
   * Specify the routing style to be associated with the handler so it receives
   * the right kinds of messages.
   *
   * Handlers for RPC messages can return a payload that will be sent as a reply.
   *
   * The validator function is responsible for processing the incoming message
   * and determining whether the payload is correct. It should return the
   * correctly typed payload. If the payload is incorrect, it should throw
   * an error.
   *
   * If the validator throws, the incoming message is silently dropped.
   *
   * For RPC messages, the validation handler is only called on incoming
   * requests. Incoming responses pass the message up to the application layer
   * without evaluation.
   *
   * For gossip messages, the validation handler should determine whether the
   * message is valid with respect to local state. If the validator throws,
   * the message is not gossiped out to other peers.
   */
  registerHandler<
    P extends PayloadType,
    S extends RoutingStyle = RoutingStyle,
    T extends MessageType = MessageType
  >(
    type: T,
    style: S,
    validator: (payload: PayloadType) => Promise<P>,
    handler: (parsedMessage: IncomingPeerMessage<RouteMap<T, P>[S]>) => ReturnMap[S],
  ): void {
    const hdlr = async (msg: IncomingPeerMessage<Message<T, PayloadType>>) => {
      let resp: P
      try {
        resp = await validator('payload' in msg.message ? msg.message.payload : undefined)
      } catch {
        // Skip the handler if the message doesn't validate
        return
      }
      const newMsg = {
        ...msg,
        message: { ...msg.message, payload: resp },
      }
      return await handler(newMsg as IncomingPeerMessage<RouteMap<T, P>[S]>)
    }

    switch (style) {
      case RoutingStyle.gossip: {
        this.gossipRouter.register(type, hdlr)
        break
      }
      case RoutingStyle.directRPC:
        this.directRpcRouter.register(
          type,
          hdlr as (message: IncomingRpcGeneric<T>) => Promise<PayloadType>,
        )
        break
      case RoutingStyle.globalRPC:
        this.globalRpcRouter.register(
          type,
          hdlr as (message: IncomingRpcGeneric<T>) => Promise<PayloadType>,
        )
        break
      case RoutingStyle.fireAndForget:
        this.fireAndForgetRouter.register(type, hdlr)
        break
    }
    this.routingStyles.set(type, style)
  }

  /**
   * Send the message to all connected peers with the expectation that they
   * will forward it to their other peers. The goal is for everyone to
   * receive the message.
   */
  gossip(message: LooseMessage): void {
    const style = this.routingStyles.get(message.type)
    if (style !== RoutingStyle.gossip) {
      throw new Error(`${message.type} type not meant to be gossipped`)
    }
    this.gossipRouter.gossip<string, PayloadType>(message)
  }

  /**
   * Send the message directly to the specified peer, if we are connected to it.
   * No response or receipt confirmation is expected.
   */
  fireAndForget(peer: Peer, message: LooseMessage): void {
    const style = this.routingStyles.get(message.type)
    if (style !== RoutingStyle.fireAndForget) {
      throw new Error(`${message.type} type not meant to be firedAndForgot`)
    }
    this.fireAndForgetRouter.fireAndForget(peer, message)
  }

  /**
   * Fire an RPC request to the given peer identity. Returns a promise that
   * will resolve when the response is received, or will be rejected if the
   * request cannot be completed before timing out.
   */
  requestFrom(
    peer: Peer,
    message: Message<MessageType, Record<string, unknown>>,
  ): Promise<IncomingPeerMessage<LooseMessage>> {
    const style = this.routingStyles.get(message.type)
    if (style !== RoutingStyle.directRPC) {
      throw new Error(`${message.type} type not meant to be direct RPC`)
    }
    return this.directRpcRouter.requestFrom(peer, message)
  }

  /**
   * Fire a global RPC request to a randomly chosen identity, retrying with other
   * peers if the first one fails. Returns a promise that will resolve when the
   * response is received, or throw an error if the request cannot be completed
   * before timing out.
   */
  async request(
    message: Message<MessageType, Record<string, unknown>>,
    peer?: Identity,
  ): Promise<IncomingPeerMessage<LooseMessage>> {
    const style = this.routingStyles.get(message.type)

    if (style !== RoutingStyle.globalRPC) {
      throw new Error(`${message.type} type not meant to be global RPC`)
    }
    return await this.globalRpcRouter.request(message, peer)
  }

  private async handleMessage(
    peer: Peer,
    incomingMessage: IncomingPeerMessage<LooseMessage>,
  ): Promise<void> {
    const { message } = incomingMessage
    let style = this.routingStyles.get(message.type)
    if (style === undefined) {
      if (message.type === InternalMessageType.cannotSatisfyRequest) {
        style = RoutingStyle.globalRPC
      } else {
        this.logger.warn('Received unknown message type', message.type)
        return
      }
    }

    switch (style) {
      case RoutingStyle.gossip:
        if (!isGossip(message)) {
          this.logger.warn('Handler', message.type, 'expected gossip')
          return
        }
        await this.gossipRouter.handle(peer, message)
        break
      case RoutingStyle.directRPC:
        if (!isRpc(message)) {
          this.logger.warn('Handler', message.type, 'expected RPC')
          return
        }
        await this.directRpcRouter.handle(peer, message)
        break
      case RoutingStyle.globalRPC:
        if (!isRpc(message)) {
          this.logger.warn('Handler', message.type, 'expected (global) RPC')
          return
        }
        await this.globalRpcRouter.handle(peer, message)
        break
      case RoutingStyle.fireAndForget:
        await this.fireAndForgetRouter.handle(peer, message)
        break
    }
  }

  private updateIsReady(): void {
    const prevIsReady = this._isReady
    this._isReady = this.started && this.peerManager.getConnectedPeers().length >= this.minPeers

    if (this._isReady !== prevIsReady) {
      this.onIsReadyChanged.emit(this._isReady)
    }
  }

  private onBlockRequest(message: IncomingPeerMessage<BlockRequestMessage>) {
    return this.node.syncer.handleBlockRequest(message)
  }

  private onBlockResponses(
    message: IncomingPeerMessage<BlocksResponseMessage>,
    originalRequest: BlockRequest,
  ) {
    return this.node.syncer.handleBlockResponse(message, originalRequest)
  }

  private onNewBlock(message: IncomingPeerMessage<NewBlockMessage>) {
    const block = message.message.payload.block
    const peer = message.peerIdentity
    return this.node.syncer.addBlockToProcess(block, peer, NetworkBlockType.GOSSIP)
  }

  private async onNewTransaction(
    message: IncomingPeerMessage<NewTransactionMessage>,
  ): Promise<void> {
    const transaction = message.message.payload.transaction

    if (this.node.memPool.acceptTransaction(transaction)) {
      await this.node.accounts.syncTransaction(transaction, {})
    }

    await Promise.resolve()
  }
}
