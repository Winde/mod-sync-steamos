import * as eldenring from "./eldenring";
import * as bg3 from "./bg3";
import type {
  BuildOption,
  BuildPackOptions,
  BuildPackResult,
  ContentsInput,
  ContentsSummary,
  GameInfo,
} from "../types";

export interface Driver {
  GAME: GameInfo;
  defaultSource(): string;
  buildOptions(): BuildOption[];
  buildPack(options: BuildPackOptions): Promise<BuildPackResult>;
  contentsFor(input: ContentsInput): ContentsSummary;
}

const drivers: Record<string, Driver> = {
  eldenring,
  bg3,
};

export function driverFor(game: string): Driver {
  const driver = drivers[game];
  if (!driver) throw new Error(`No driver for game: ${game}`);
  return driver;
}

export { drivers, eldenring, bg3 };
