import { IWDEE, buildOptions, buildPackFor, contentsForGame, defaultSourceFor } from "./infinity";
import type { BuildPackOptions, BuildPackResult, ContentsInput, ContentsSummary } from "../types";

export const GAME = IWDEE;

export function defaultSource(): string {
  return defaultSourceFor(IWDEE);
}

export { buildOptions };

export function buildPack(options: BuildPackOptions): Promise<BuildPackResult> {
  return buildPackFor(IWDEE, options);
}

export function contentsFor(input: ContentsInput): ContentsSummary {
  return contentsForGame(IWDEE, input);
}
