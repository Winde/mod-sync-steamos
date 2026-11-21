const eldenring = require("./eldenring");
const bg3 = require("./bg3");

const drivers = { eldenring, bg3 };

function driverFor(game) {
  const driver = drivers[game];
  if (!driver) throw new Error(`No driver for game: ${game}`);
  return driver;
}

module.exports = { drivers, driverFor };
