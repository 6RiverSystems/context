import * as chai from 'chai';
import * as chaiAsPromised from 'chai-as-promised';
const {expect} = chai;
chai.use(chaiAsPromised);

import {
	Context,
	CancelFunc,
	background,
	withCancel,
	withTimeout,
	cancelledErr,
	deadlineExceededErr,
} from '../src/context';

describe('Context', function() {
	describe('withCancel', function() {
		it('should allow to cancel context', async function() {
			const [ctx, cancel] = withCancel(background());

			setTimeout(cancel, 500);
			await ctx.done();

			expect(ctx.error()).to.equal(cancelledErr);
		});

		it('should cancel child context', async function() {
			const [parentCtx, cancel] = withCancel(background());
			const [childCtx1] = withCancel(parentCtx);
			const [childCtx2] = withCancel(parentCtx);

			setTimeout(cancel, 500);
			await childCtx1.done();
			await childCtx2.done();

			expect(parentCtx.error()).to.equal(cancelledErr);
			expect(childCtx1.error()).to.equal(cancelledErr);
			expect(childCtx2.error()).to.equal(cancelledErr);
		});

		it('should not cancel parent context', async function() {
			const [parentCtx] = withCancel(background());
			const [childCtx, cancel] = withCancel(parentCtx);

			setTimeout(cancel, 500);
			await childCtx.done();

			expect(childCtx.error()).to.equal(cancelledErr);
			expect(parentCtx.error()).to.be.null;
		});


		it('should not cancel sibling context', async function() {
			const [parentCtx] = withCancel(background());
			const [childCtx1, cancel] = withCancel(parentCtx);
			const [childCtx2] = withCancel(parentCtx);

			setTimeout(cancel, 500);
			await childCtx1.done();

			expect(childCtx1.error()).to.equal(cancelledErr);
			expect(childCtx2.error()).to.be.null;
			expect(parentCtx.error()).to.be.null;
		});

		context('with cancelled parent context', function() {
			let parent: Context;
			let cancel: Function;

			beforeEach(async function() {
				[parent, cancel] = withCancel(background());
				cancel();

				await parent.done();
			});

			it('should instantly make child context cancelled', async function() {
				const [child] = withCancel(parent);

				expect(child.done()).to.be.fulfilled;
				expect(child.error()).to.equal(cancelledErr);
			});
		});
	});


	context('withTimeout', function() {
		async function probe(ctx: Context, milisecs: number): Promise<number> {
			let resolve: Function;
			const p = new Promise((f) => {
				resolve = f;
			});
			const timer = setTimeout(() => resolve(), milisecs);
			const start = Date.now();

			return Promise.race([p, ctx.done()]).then(() => {
				if (ctx.error()) {
					clearTimeout(timer);
				}
				return Date.now() - start;
			});
		}

		it('should not cancel earlier than timeout', async function() {
			const [ctx, cancel] = withTimeout(background(), 1000);

			try {
				const t = await probe(ctx, 100);

				expect(t).to.be.within(100, 110);
				expect(ctx.error()).to.be.null;
			} finally {
				cancel();
			}
		});

		it('should cancel context by timeout', async function() {
			const [ctx, cancel] = withTimeout(background(), 100);

			try {
				const t = await probe(ctx, 10000);

				expect(t).to.be.within(100, 110);
				expect(ctx.error()).to.equal(deadlineExceededErr);
			} finally {
				cancel();
			}
		});

		it('should timeout on parent context if it has ealier deadline', async function() {
			const [parentCtx, cancelParent] = withTimeout(background(), 100);
			const [childCtx, cancelChild] = withTimeout(parentCtx, 200);

			try {
				const t = await probe(childCtx, 10000);

				expect(t).to.be.within(100, 110);
				expect(childCtx.error()).to.equal(deadlineExceededErr);
				expect(parentCtx.error()).to.equal(deadlineExceededErr);
			} finally {
				cancelChild();
				cancelParent();
			}
		});
	});
});
