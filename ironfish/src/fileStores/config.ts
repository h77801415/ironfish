/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { DEFAULT_DATA_DIR } from './fileStore'
import { FileSystem } from '../fileSystems'
import { KeyStore } from './keyStore'
import * as yup from 'yup'

export const DEFAULT_CONFIG_NAME = 'config.json'
export const DEFAULT_DATABASE_NAME = 'default'
export const DEFAULT_WALLET_NAME = 'default'
export const DEFAULT_WEBSOCKET_PORT = 9033
export const DEFAULT_GET_FUNDS_API = 'https://api.ironfish.network/api/v1/getFunds'
export const DEFAULT_TELEMETRY_API = 'https://api.ironfish.network/api/v1/writeTelemetry'
export const DEFAULT_BOOTSTRAP_NODE = 'test.bn1.ironfish.network'

export type ConfigOptions = {
  bootstrapNodes: string[]
  databaseName: string
  editor: string
  enableListenP2P: boolean
  enableMiningDirector: boolean
  enableRpc: boolean
  enableRpcIpc: boolean
  enableRpcTcp: boolean
  enableSyncing: boolean
  enableTelemetry: boolean
  enableMetrics: boolean
  getFundsApi: string
  ipcPath: string
  /**
   * Worker nodes are nodes that are intended to only connect to one node
   * directly and should not be broadcast to other peers. For example, a
   * single mining director connected to a public node is a worker node.
   *
   * Often worker nodes are behind firewalls anyway so they cannot be
   * connected to.
   * */
  isWorker: boolean
  /**
   * Should the mining director mine, even if we are not synced?
   * Only useful if no miner has been on the network in a long time
   * otherwise you should not turn this on or you'll create useless
   * forks while you sync.
   */
  miningForce: boolean
  /**
   * True if you want to send worker peers out to other clients or not
   * */
  broadcastWorkers: boolean
  /**
   * Log levels are formatted like so:
   * `*:warn,tag:info`
   *
   * ex: `warn` or `*:warn` displays only logs that are warns or errors.
   *
   * ex: `*:warn,peernetwork:info` displays warns and errors, as well as info
   *     logs from peernetwork and its submodules.
   */
  logLevel: string
  /**
   * String to be prefixed to all logs. Accepts the following replacements:
   * %time% : The time of the log
   * %tag% : The tags on the log
   * %level% : The log level
   *
   * ex: `[%time%] [%level%] [%tag%]`
   */
  logPrefix: string
  /**
   * When mining new blocks, blockGraffiti will be set on the `graffiti` field of
   * newly created blocks.
   * Length is truncated to 32 bytes.
   */
  blockGraffiti: string
  nodeName: string
  p2pSimulateLatency: number
  peerPort: number
  rpcTcpHost: string
  rpcTcpPort: number
  rpcRetryConnect: boolean
  /**
   * The maximum number of peers we can be connected to at a time. Past this number,
   * new connections will be rejected.
   */
  maxPeers: number
  minPeers: number
  /**
   * The ideal number of peers we'd like to be connected to. The node will attempt to
   * establish new connections when below this number.
   */
  targetPeers: number
  telemetryApi: string
  accountName: string
}

export const ConfigOptionsSchema: yup.ObjectSchema<Partial<ConfigOptions>> = yup
  .object()
  .shape({})
  .defined()

export class Config extends KeyStore<ConfigOptions> {
  constructor(files: FileSystem, dataDir?: string, configName?: string) {
    super(
      files,
      configName || DEFAULT_CONFIG_NAME,
      Config.GetDefaults(files, dataDir || DEFAULT_DATA_DIR),
      dataDir || DEFAULT_DATA_DIR,
      ConfigOptionsSchema,
    )
  }

  get chainDatabasePath(): string {
    return this.files.join(this.storage.dataDir, 'databases', this.get('databaseName'))
  }

  get accountDatabasePath(): string {
    return this.files.join(this.storage.dataDir, 'accounts', this.get('accountName'))
  }

  static GetDefaults(files: FileSystem, dataDir: string): ConfigOptions {
    return {
      broadcastWorkers: true,
      bootstrapNodes: [DEFAULT_BOOTSTRAP_NODE],
      databaseName: DEFAULT_DATABASE_NAME,
      editor: '',
      enableListenP2P: true,
      enableMiningDirector: false,
      enableRpc: true,
      enableRpcIpc: true,
      enableRpcTcp: false,
      enableSyncing: true,
      enableTelemetry: false,
      enableMetrics: true,
      getFundsApi: DEFAULT_GET_FUNDS_API,
      ipcPath: files.resolve(files.join(dataDir || DEFAULT_DATA_DIR, 'ironfish.ipc')),
      isWorker: false,
      logLevel: '*:info',
      logPrefix: '',
      miningForce: false,
      blockGraffiti: '',
      nodeName: '',
      p2pSimulateLatency: 0,
      peerPort: DEFAULT_WEBSOCKET_PORT,
      rpcTcpHost: 'localhost',
      rpcTcpPort: 8020,
      rpcRetryConnect: false,
      maxPeers: 50,
      minPeers: 1,
      targetPeers: 50,
      telemetryApi: DEFAULT_TELEMETRY_API,
      accountName: DEFAULT_WALLET_NAME,
    }
  }
}
