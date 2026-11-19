// middleware that implements a Lamport Logical Clock to track the order of events across a distributed system
// Not actually used for anything rn?
const clock = require("../utils/lamportClock.js");

export const lamportSync = (req, res, next) => {
  // check for incoming timestamp
  const incomingTimestamp = req.headers["x-lamport-clock"];

  //update local clock
  if (incomingTimestamp !== undefined) {
    clock.sync(incomingTimestamp); // If header exists
  } else {
    clock.tick(); // New chain of events
  }

  req.lamportTimestamp = clock.now(); // save updated timestamp
  res.setHeader("X-Lamport-Clock", req.lamportTimestamp); // add to outgoing HTTP response
  next(); // move on
};
