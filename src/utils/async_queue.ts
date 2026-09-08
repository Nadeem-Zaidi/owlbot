export class AsyncQueue<T> {
    private readonly items: T[] = [];
    private readonly consumerWaiters: Array<() => void> = [];
    private readonly producerWaiters: Array<() => void> = [];
    private _closed = false;

    constructor(private readonly maxSize: number = 500) {}

    get size(): number {
        return this.items.length;
    }

    get closed(): boolean {
        return this._closed;
    }

    /**
     * Pushes an item onto the queue, waiting for space if the queue is full.
     * Returns `true` if the item was actually enqueued, or `false` if the
     * queue was (or became) closed before the item could be pushed — in
     * that case the item is discarded and the caller should NOT count it
     * as delivered.
     */
    async enqueue(item: T): Promise<boolean> {
        while (this.items.length >= this.maxSize) {
            if (this._closed) return false;
            await new Promise<void>(resolve => this.producerWaiters.push(resolve));
        }
        if (this._closed) return false;
        this.items.push(item);
        this.consumerWaiters.shift()?.();
        return true;
    }

    /**
     * Pops the next item off the queue, waiting if it's empty.
     * Returns `null` only once the queue is closed AND drained — i.e.
     * "there will never be another item." Callers must not enqueue `null`
     * as a real value, since it's reserved as the end-of-stream sentinel.
     */
    async deque(): Promise<T | null> {
        while (true) {
            if (this.items.length > 0) {
                const item = this.items.shift()!;
                this.producerWaiters.shift()?.();
                return item;
            }
            if (this._closed) return null;
            await new Promise<void>(resolve => this.consumerWaiters.push(resolve));
        }
    }

    close(): void {
        this._closed = true;
        for (const w of this.producerWaiters.splice(0)) w();
        for (const w of this.consumerWaiters.splice(0)) w();
    }

    [Symbol.asyncIterator](): AsyncIterator<T> {
        return {
            next: async (): Promise<IteratorResult<T>> => {
                const value = await this.deque();
                if (value === null) {
                    return { value: undefined as any, done: true };
                }
                return { value, done: false };
            },
        };
    }
}


export class FileQueue<T> {
    private readonly paths: T[];
    private _dispatched = 0;

    constructor(paths: T[]) {
        this.paths = paths;
    }

    next(): T | undefined {
        const p = this.paths.shift();
        if (p !== undefined) this._dispatched++;
        return p;
    }

    get total(): number {
        return this._dispatched + this.paths.length;
    }

    get remaining(): number {
        return this.paths.length;
    }
}