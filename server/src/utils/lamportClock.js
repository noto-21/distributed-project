class LamportClock {
  constructor(initialTime = 0) {
    this.time = initialTime;
  }

  tick() {
    // + 1 to clock
    this.time += 1;
    return this.time;
  }

  sync(receivedTime) {
    // Updates the clock when receiving a message from another node
    const parsed = Number(receivedTime);
    if (!Number.isNaN(parsed) && parsed >= 0) {
      // Is a real number
      this.time = Math.max(this.time, parsed) + 1; // Take the higher number and + 1
    } else {
      this.time += 1; // Ignore and + 1
    }
    return this.time;
  }

  now() {
    // returns the current time
    return this.time;
  }
}

const clock = new LamportClock();
module.exports = clock;
