import { PSTEE, buildOptions, buildPackFor, contentsForGame, defaultSourceFor } from "./infinity";
import type { BuildPackOptions, BuildPackResult, ContentsInput, ContentsSummary } from "../types";

export const GAME = PSTEE;

export function defaultSource(): string {
  return defaultSourceFor(PSTEE);
}

export { buildOptions };

export function buildPack(options: BuildPackOptions): Promise<BuildPackResult> {
  return buildPackFor(PSTEE, options);
}

export function contentsFor(input: ContentsInput): ContentsSummary {
  return contentsForGame(PSTEE, input);
}
