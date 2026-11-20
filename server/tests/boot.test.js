// Boot keeps retrying the DB instead of crashing (nodemon never restarts a crashed app).
process.env.BRANCH_ID = "oshawa";
process.env.MONGO_URI = "mongodb://localhost:27017/library_test";
const { connectWithRetry } = require("../src/server");

test("retries until the database is reachable, logging each failure", async () => {
  const connect = jest.fn()
    .mockRejectedValueOnce(new Error("ReplicaSetNoPrimary"))
    .mockRejectedValueOnce(new Error("IP not whitelisted"))
    .mockResolvedValueOnce("connected");
  const log = jest.fn();

  await expect(connectWithRetry({ connect, delayMs: 1, log })).resolves.toBe("connected");

  expect(connect).toHaveBeenCalledTimes(3);
  expect(log).toHaveBeenCalledTimes(2);
  expect(log.mock.calls[1][0]).toMatch(/attempt 2.*IP not whitelisted/);
});
