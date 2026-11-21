import * as eldenring from "./eldenring";
import * as bg3 from "./bg3";
import type { BuildPackOptions, BuildPackResult, ContentsSummary, GameInfo } from "../types";

export interface Driver {
  GAME: GameInfo;
  defaultSource(): string;
  buildPack(options: BuildPackOptions): Promise<BuildPackResult>;
  // Drivers keep their own contents inputs (profile path vs paks).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  contentsFor(...args: any[]): ContentsSummary;
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
