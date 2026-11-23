// The deck validator the game injects into the profile: sim-core's
// `validate_deck` through WASM (`sim-wasm`'s marshalling-only export), so
// the deck builder and the match refuse exactly what the core refuses.
import type { DeckError, DeckValidator } from "../profile/types";

/** Wrap the WASM export (`validate_deck(card_ids_json) -> errors_json`). */
export function wasmDeckValidator(validate: (cardIdsJson: string) => string): DeckValidator {
  return (cardIds) => JSON.parse(validate(JSON.stringify(cardIds))) as DeckError[];
}

/** Load the web WASM build (the same module the worker uses, initialised
 *  once on the page) and return the core's validator. */
export async function loadWasmDeckValidator(): Promise<DeckValidator> {
  const mod = await import("../wasm/pkg/sim_wasm.js");
  await mod.default();
  return wasmDeckValidator(mod.validate_deck);
}
