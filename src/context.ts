export type ErrorType = Error | null;

// A Context carries a deadline, a cancelation signal, and other values across
// API boundaries.
export interface Context {
	// deadline returns the time when work done on behalf of this context should be canceled.
	// deadline returns null when no deadline is set.
  // Successive calls to deadline return the same results.
	deadline(): Date | null;

	// done returns a promise that's resolved when work done on behalf of this
	// context should be canceled.
	// done may return a promise that will never reolve if this context can
	// never be canceled.
	// Successive calls to done return the same value.
	//
	// withCancel arranges for done() to be closed when cancel is called;
	// withDeadline arranges for done() to be closed when the deadline expires;
	// withTimeout arranges for done() to be closed when the timeout elapses.
	done(): Promise<void>;

	// If done() is not yet resolved, returns nil.
	// If done() is resolved, returns a non-nil error explaining why:
	// canceledErr if the context was canceled
	// or deadlineExceededErr if the context's deadline passed.
	// After error() returns a non-nil error, successive calls to error() return the same error.
	error(): ErrorType;
}

// canceledErr is the error returned by Context.error() when the context is canceled.
export const cancelledErr = new Error('context cancelled');

// deadlineExceededErr is the error returned by Context.error when the context's
// deadline passes.
export const deadlineExceededErr = new Error('context deadline exceeded');

// blockForever is a reusable unresolvable promise.
const blockForever: Promise<void> = new Promise((resolve, reject) => {});

// alwaysResolve is a reusable resolved promise.
const alwaysResolve: Promise<void> = Promise.resolve();

// An emptyCtx is never canceled, has no values, and has no deadline.
class EmptyCtx implements Context {
	deadline(): Date | null {
		return null;
	}

	done(): Promise<void> {
		return blockForever;
	}

	error(): ErrorType {
		return null;
	}
}

const backgroundCtx: Context = new EmptyCtx();

// background returns a non-nil, empty Context.
// It is never canceled, and has no deadline.
// It is typically used as the top-level Context for incoming requests.
export function background(): Context {
	return backgroundCtx;
}

// A CancelFunc tells an operation to abandon its work.
// A CancelFunc does not wait for the work to stop.
// After the first call, subsequent calls to a CancelFunc do nothing.
export interface CancelFunc {
	(): void;
}

// withCancel returns a copy of parent with a new done promise.
// The returned context's done() promise is resolved when the returned cancel function is called
// or when the parent context's done() promise is resolved, whichever happens first.
//
// Canceling this context releases resources associated with it, so code should
// call cancel as soon as the operations running in this Context complete.
export function withCancel(parent: Context): [Context, CancelFunc] {
	const c = new CancelCtx(parent);
	const cancel = () => {
		c.cancel(true, cancelledErr);
	};

	propagateCancel(parent, c);
	return [c, cancel];
}

// A canceler is a context type that can be canceled directly. The
// implementations are cancelCtx and timerCtx (which extends cancelCtx).
interface Canceler {
	cancel(removeFromParent: boolean, err: ErrorType): void;
	done(): Promise<void>;
}

// propagateCancel arranges for child to be canceled when parent is.
function propagateCancel(parent: Context, child: Canceler): void {
	if (parent.done() === blockForever) {
		return; // parent is never canceled
	}

	const p = parentCancelCtx(parent);

	if (p) {
		if (p.err) {
			// parent has already been canceled
			child.cancel(false, p.err);
		} else {
			if (!p.children) {
				p.children = new Set();
			}
			p.children.add(child);
		}
	} else {
		const parentDone = parent.done().then(() => true);
		const childDone = child.done().then(() => false);

		Promise.race([parentDone, childDone]).then((cancelChild) => {
			if (cancelChild) {
				child.cancel(false, parent.error());
			}
		});
	}
}

// parentCancelCtx follows a chain of parent references until it finds a cancelCtx.
function parentCancelCtx(parent: Context): CancelCtx | null {
	if (parent instanceof CancelCtx) {
		return parent;
	} else {
		return null;
	}
}

// removeChild removes a context from its parent.
function removeChild(parent: Context, child: Canceler) {
	const p = parentCancelCtx(parent);
	if (!p) {
		return;
	}
	if (p.children) {
		p.children.delete(child);
	}
}

// CancelCtx can be canceled.
// When canceled, it also cancels any children that implement canceler.
class CancelCtx implements Context, Canceler {
	_done?: Promise<void>; // created lazily, closed by first cancel call
	err: ErrorType = null; // set to non-nil by the first cancel call
	resolve!: Function;
	children!: Set<Canceler>; // set to nil by the first cancel call

	constructor(private parent: Context) {}

	deadline(): Date | null {
		return null;
	}

	done(): Promise<void> {
		if (!this._done) {
			const self = this;

			this._done = new Promise((resolve) => {
				self.resolve = resolve;
			});
		}
		return this._done;
	}

	error(): ErrorType {
		return this.err;
	}

	// cancel resolves ctx.done() promise, cancels each of c's children, and, if
	// removeFromParent is true, removes ctx from its parent's children.
	cancel(removeFromParent: boolean, err: ErrorType): void {
		if (!err) {
			throw Error('context: internal error: missing cancel error');
		}

		if (this.err) {
			return; // already cancelled
		}

		this.err = err;

		if (!this._done) {
			this._done = alwaysResolve;
		} else {
			this.resolve();
		}

		if (this.children) {
			for (const child of this.children) {
				child.cancel(false, err);
			}
		}

		if (removeFromParent) {
			removeChild(this.parent, this);
		}
	}
}

// withDeadline returns a copy of the parent context with the deadline adjusted
// to be no later than d. If the parent's deadline is already earlier than d,
// withDeadline(parent, d) is semantically equivalent to parent. The returned
// context's done promise is resolved when the deadline expires, when the returned
// cancel function is called, or when the parent context's done promise is
// resolved, whichever happens first.
//
// Canceling this clears the timer associated with it, so code should
// call cancel as soon as the operations running in this Context complete.
function withDeadline(parent: Context, deadline: Date): [Context, CancelFunc] {
	const parentDeadline = parent.deadline();

	if (parentDeadline && parentDeadline < deadline) {
		// The current deadline is already sooner than the new one.
		return withCancel(parent);
	}

	const c = new TimerCtx(parent, deadline);

	propagateCancel(parent, c);

	const d = deadline.getTime() - Date.now();

	if (d <= 0) {
		c.cancel(true, deadlineExceededErr); // deadline has already passed
		return [c, () => {
			c.cancel(true, cancelledErr);
		}];
	}

	if (!c.err) {
		c.timer = setTimeout(() => {
			c.cancel(true, deadlineExceededErr);
		}, d);
	}
	return [c, () => {
		c.cancel(true, cancelledErr);
	}];
}

// WithTimeout returns WithDeadline(parent, new Date(Date.now() + milisecs)).
//
// Canceling this context releases resources associated with it, so code should
// call cancel as soon as the operations running in this Context complete:
//
// 	function slowOperationWithTimeout(ctx: Context): Result {
//		const [ctx, cancel] = withTimeout(ctx, 100);
//		try {
//			const result = slowOperation(ctx);
//		} finally {
//			cancel();
//			return result;
//		}
// 	}
export function withTimeout(parent: Context, timeout: number): [Context, CancelFunc] {
	return withDeadline(parent, new Date(Date.now() + timeout));
}

// A TimerCtx carries a timer ID and a deadline.
// It extends CancelCtx and overrides its cancel method to clear the timer.
class TimerCtx extends CancelCtx {
	timer?: number;

	constructor(parent: Context, private _deadline: Date) {
		super(parent);
	}

	deadline(): Date | null {
		return this._deadline;
	}

	cancel(removeFromParent: boolean, err: Error) {
		super.cancel(removeFromParent, err);
		if (this.timer) {
			clearTimeout(this.timer);
			this.timer = undefined;
		}
	}
}
