/**
 * Imported first by the `datanotes` command (cli.ts), before anything starts libuv's thread pool
 * (the first asynchronous file call does): every file read and stat of the engine runs there.
 * Node's default is 4 threads; on Windows each open of a note waits for the antivirus scan, so a
 * start that reads thousands of notes 64 at a time keeps 4 threads busy and the rest waiting:
 * 16 threads read 20,000 notes in 1.3 s instead of 3 s. A value the user set is kept.
 */

/** The thread pool's size when the environment does not set `UV_THREADPOOL_SIZE`. */
export const THREAD_POOL_SIZE = 16;

if (!process.env.UV_THREADPOOL_SIZE) process.env.UV_THREADPOOL_SIZE = String(THREAD_POOL_SIZE);
