import { BG1, buildOptions, buildPackFor, contentsForGame, defaultSourceFor } from "./infinity";
import type { BuildPackOptions, BuildPackResult, ContentsInput, ContentsSummary } from "../types";

export const GAME = BG1;

export function defaultSource(): string {
  return defaultSourceFor(BG1);
}

export { buildOptions };

export function buildPack(options: BuildPackOptions): Promise<BuildPackResult> {
  return buildPackFor(BG1, options);
}

export function contentsFor(input: ContentsInput): ContentsSummary {
  return contentsForGame(BG1, input);
}
