// Mounted-pet truth for a travel leg — world.move's BOTH-END rule: the chain applies the ×1.5 pet
// speed only across a leg whose checkpoint STARTED with a pet equipped (`cp.pet`, the field the
// last prove_move saved) AND still has one now (`equipment::pet_equipped`, a pet sitting the "pet"
// equipment slot). Both halves are on-chain reads the bot already owns — the Checkpoint struct and
// the EquipmentKey field — so a caller plans a leg at exactly the speed the chain will prove.
//
// Defensive direction is fixed: a failed read must DEGRADE TO UNMOUNTED (the honest slow plan is
// always provable; an assumed mount can earn an ETravelTooFar). Callers wrap this read in their own
// retry/log fallback — it throws like any other chain read.
import type { BotSdk } from '../auth/sdk_client.ts'
import { read_character_checkpoint } from '../../../sdk/src/character_checkpoint.ts'
import { read_equipped_items } from '../fight/equipped_weapon.ts'

export const PET_SLOT = 'pet'

export const read_pet_mounted = async (bot: BotSdk, character_id: string, world: string): Promise<boolean> => {
  const [checkpoint, equipped] = await Promise.all([
    read_character_checkpoint(bot.sdk.sui_client.core as never, bot.sdk.game_type_package, character_id, world),
    read_equipped_items(bot.sdk as never, character_id),
  ])
  return (checkpoint?.pet ?? false) && equipped.some((row) => row.slot === PET_SLOT)
}