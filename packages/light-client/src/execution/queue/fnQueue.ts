import {JobItemQueue} from "./itemQueue.js";
import {JobQueueOpts} from "./options.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Fn<R> = (...args: any) => Promise<R>;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export class JobFnQueue extends JobItemQueue<[Fn<any>], any> {
  constructor(opts: JobQueueOpts) {
    super((fn) => fn(), opts);
  }

  push<R, F extends Fn<R> = Fn<R>>(fn: F): Promise<R> {
    return super.push(fn) as Promise<R>;
  }
}
