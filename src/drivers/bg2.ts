import { BG2, buildOptions, buildPackFor, contentsForGame, defaultSourceFor } from "./infinity";
import type { BuildPackOptions, BuildPackResult, ContentsInput, ContentsSummary } from "../types";

export const GAME = BG2;

export function defaultSource(): string {
  return defaultSourceFor(BG2);
}

export { buildOptions };

export function buildPack(options: BuildPackOptions): Promise<BuildPackResult> {
  return buildPackFor(BG2, options);
}

export function contentsFor(input: ContentsInput): ContentsSummary {
  return contentsForGame(BG2, input);
}
