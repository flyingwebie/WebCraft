/**
 * Running an expression (`expressions.ts` reads, writes and checks them): whether a Condition's test
 * passes on a page. Its comparisons read values as text (`value-text.ts`), rich text without its
 * markup, so the code that only reads and writes Template markup in the browser never loads it.
 */
import type { Expression, RenderTime } from "./expressions.ts";
import { compareValues, holds, isPresent, sameValue } from "./value-text.ts";
import { type TemplateValue, toDate } from "./values.ts";

const ORDER_OPERATORS: ReadonlySet<string> = new Set(["<", "<=", ">", ">="]);

/** Whether an expression's test passes, reading values with `read`; `now` reads `time` (nothing without it). */
export function passes(expression: Expression, read: (path: string) => TemplateValue, time?: RenderTime): boolean {
	return isPresent(evaluate(expression, read, time));
}

function evaluate(expression: Expression, read: (path: string) => TemplateValue, time?: RenderTime): TemplateValue {
	switch (expression.type) {
		case "value":
			return read(expression.path);
		case "literal":
			return expression.value;
		case "now":
			return time?.now;
		case "not":
			return !passes(expression.operand, read, time);
		case "and":
			return passes(expression.left, read, time) && passes(expression.right, read, time);
		case "or":
			return passes(expression.left, read, time) || passes(expression.right, read, time);
		case "compare": {
			const left = evaluate(expression.left, read, time);
			const right = evaluate(expression.right, read, time);
			if (time && ORDER_OPERATORS.has(expression.operator)) {
				// A test of now against a later date answers differently once that date comes.
				const other = expression.left.type === "now" ? right : expression.right.type === "now" ? left : undefined;
				const date = other === undefined ? undefined : toDate(other);
				if (date && date.getTime() > time.now.getTime()) time.changesAt(date);
			}
			switch (expression.operator) {
				case "==":
					return sameValue(left, right);
				case "!=":
					return !sameValue(left, right);
				case "contains":
					return holds(left, right);
				default: {
					const order = compareValues(left, right);
					if (order === undefined) return false;
					if (expression.operator === "<") return order < 0;
					if (expression.operator === "<=") return order <= 0;
					if (expression.operator === ">") return order > 0;
					return order >= 0;
				}
			}
		}
	}
}
