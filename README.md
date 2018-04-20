# Context

This is a promise-based port of Go conext library.

Package context defines the Context type, which carries deadlines, cancelation signals, and other request-scoped values across API boundaries.

Incoming requests to a service should create a Context, and outgoing calls to service should accept a Context. The chain of function calls between them must propagate the Context, optionally replacing it with a derived Context created using withCancel, withDeadline, withTimeout, or withValue. When a Context is canceled, all Contexts derived from it are also canceled.

The withCancel, withDeadline, and withTimeout functions take a Context (the parent) and return a derived Context (the child) and a CancelFunc. Calling the CancelFunc cancels the child and its children, removes the parent's reference to the child, and stops any associated timers. Failing to call the CancelFunc leaks the child and its children until the parent is canceled or the timer fires.

Programs that use Contexts should follow these rules to keep interfaces consistent across packages and enable static analysis tools to check context propagation:

Do not store Contexts inside a struct type; instead, pass a Context explicitly to each function that needs it. The Context should be the first parameter, typically named ctx:

function doSomething(ctx: context.Context, arg: Arg) {
	// ... use ctx ...
}

Use context Values only for request-scoped data that transits processes and APIs, not for passing optional parameters to functions.


