/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { IronfishStrategy } from '../strategy'

export class IronfishTestStrategy extends IronfishStrategy {
  private _miningReward: number | null = null

  disableMiningReward(): void {
    this._miningReward = 0
  }

  miningReward(sequence: bigint): number {
    if (this._miningReward !== null) {
      return this._miningReward
    }

    return super.miningReward(sequence)
  }
}
