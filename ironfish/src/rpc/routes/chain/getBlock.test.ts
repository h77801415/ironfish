/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { createRouteTest } from '../../../testUtilities/routeTest'
import { useMinerBlockFixture } from '../../../testUtilities/fixtures'
import { GENESIS_BLOCK_SEQUENCE } from '../../../consensus'
import { GetBlockResponse } from './getBlock'
import { BlockHashSerdeInstance } from '../../../serde'

describe('Route chain.getBlock', () => {
  const routeTest = createRouteTest()

  it('should fail if no sequence or hash provided', async () => {
    await expect(routeTest.adapter.request('chain/getBlock', {})).rejects.toThrow(
      'Missing hash or sequence',
    )
  })

  it(`should fail if block can't be found with hash`, async () => {
    const hash = BlockHashSerdeInstance.serialize(Buffer.alloc(32, 'blockhashnotfound'))

    await expect(routeTest.adapter.request('chain/getBlock', { hash })).rejects.toThrow(
      'No block found',
    )
  })

  it(`should fail if block can't be found with sequence`, async () => {
    await expect(routeTest.adapter.request('chain/getBlock', { index: 5 })).rejects.toThrow(
      'No block found',
    )
  })

  it('responds with a block', async () => {
    const node = routeTest.node
    const chain = routeTest.node.chain

    await node.seed()

    const block = await useMinerBlockFixture(chain, BigInt(2))
    const addResult = await chain.addBlock(block)
    expect(addResult).toMatchObject({ isAdded: true })

    // by hash first
    const hash = BlockHashSerdeInstance.serialize(block.header.hash)
    let response = await routeTest.adapter.request<GetBlockResponse>('chain/getBlock', { hash })

    expect(response.content).toMatchObject({
      timestamp: block.header.timestamp.valueOf(),
      blockIdentifier: {
        index: Number(block.header.sequence).toString(),
        hash: block.header.hash.toString('hex').toUpperCase(),
      },
      parentBlockIdentifier: {
        index: Number(GENESIS_BLOCK_SEQUENCE).toString(),
        hash: block.header.previousBlockHash.toString('hex').toUpperCase(),
      },
      metadata: {
        size: expect.any(Number),
        difficulty: Number(block.header.target.toDifficulty()),
      },
    })
    expect(response.content.transactions).toHaveLength(1)

    // now by sequence
    response = await routeTest.adapter.request<GetBlockResponse>('chain/getBlock', { index: 2 })
    expect(response.content.blockIdentifier.hash).toEqual(
      block.header.hash.toString('hex').toUpperCase(),
    )
  }, 10000)
})
