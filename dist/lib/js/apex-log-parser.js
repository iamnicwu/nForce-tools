/**
 * @apexdevtools/apex-log-parser v0.3.0 —— Salesforce Apex 调试日志解析器
 *
 * 来源：npm `@apexdevtools/apex-log-parser@0.3.0` 的 `dist/index.js`（**零依赖、ESM only、
 *       单文件自包含** —— 文件里没有任何 import/require，所以可以直接搬到 lib/js 下）。
 *       它就是 Apex Log Analyzer（VS Code 扩展）背后的解析器。
 * 许可：BSD-3-Clause © Certinia Inc. 完整许可文本见该 npm 包的 LICENSE。
 * 更新方式：`npm i @apexdevtools/apex-log-parser@<新版本>` 后把它的 `dist/index.js`
 *       粘贴到本文件（保留段注释），再跑一次 `npm test` 与 View Log 的渲染用例。
 *
 * ⚠️ 为什么是 vendor 而不是 `import("@apexdevtools/apex-log-parser")`：
 *   `src/` 本身就是**可直接加载的扩展目录**（不打包也能跑，见 README 的「开发须知」），
 *   而浏览器解析不了裸模块说明符 —— 那样会让「View Log」在不打包时直接报错。
 *   项目里 echarts / marked / xlsx / dayjs 也都是这么处理的。
 *
 * 用它的地方：`common/lib_loader.js` 的 `ensureApexLogParser()`（**按需**动态 import，
 * 这个文件约 115KB，不该进首屏）→ `common/apex_log_view.js` 把解析结果转成视图模型。
 */

//#region src/limits.ts
/** A limit value with `percentUsed` derived, null when the log stated no ceiling. */
function toLimitValue(used, limit) {
	return {
		used,
		limit,
		percentUsed: limit > 0 ? used / limit * 100 : null
	};
}
/** Every metric at zero, with no ceiling. The one place a `Limits` is built from nothing. */
function emptyLimits() {
	const zero = () => toLimitValue(0, 0);
	return {
		soqlQueries: zero(),
		soslQueries: zero(),
		queryRows: zero(),
		dmlStatements: zero(),
		publishImmediateDml: zero(),
		dmlRows: zero(),
		cpuTime: zero(),
		heapSize: zero(),
		callouts: zero(),
		emailInvocations: zero(),
		futureCalls: zero(),
		queueableJobsAddedToQueue: zero(),
		mobileApexPushCalls: zero()
	};
}
/** An empty limit set: no snapshots, so nothing derived from them either. */
function emptyGovernorLimits() {
	return {
		snapshots: [],
		final: emptyLimits(),
		peak: emptyLimits(),
		byNamespace: /* @__PURE__ */ new Map()
	};
}
const LIMIT_METRIC_KEYS = Object.keys(emptyLimits());
/**
* Limits the platform shares across namespaces, so the per-namespace figures are not additive:
* combining them takes the highest, not the sum.
*/
const SHARED_METRICS = /* @__PURE__ */ new Set(["heapSize"]);
/**
* Fold `used` per metric across sources. `limit` takes the highest stated ceiling, because 0 means
* the source stated none and no log states two different ceilings for one metric.
*/
function foldLimits(sources, foldUsed) {
	const folded = emptyLimits();
	for (const source of sources) for (const metric of LIMIT_METRIC_KEYS) {
		const running = folded[metric];
		const next = source[metric];
		folded[metric] = toLimitValue(foldUsed(metric, running.used, next.used), Math.max(running.limit, next.limit));
	}
	return folded;
}
/** Combine per-namespace limits into one figure: summed, except the shared limits. */
function combineLimits(sources) {
	return foldLimits(sources, (metric, running, next) => SHARED_METRICS.has(metric) ? Math.max(running, next) : running + next);
}
/** The highest `used` each metric reached across the sources. */
function maxLimits(sources) {
	return foldLimits(sources, (_metric, running, next) => Math.max(running, next));
}
/** A detached copy, so a caller cannot reach back into the snapshot it came from. */
function copyLimits(limits) {
	return maxLimits([limits]);
}
/** A source that states heap alone, so a heap figure from elsewhere folds in like any other. */
function heapOnly(used) {
	return {
		...emptyLimits(),
		heapSize: toLimitValue(used, 0)
	};
}
/**
* Derives the whole-log and per-namespace figures from the snapshots, which are in log order. A
* namespace states a cumulative total each time, so its last snapshot is its final figure, and the
* combined figure at any timepoint carries every other namespace forward.
*
* `heapPeak` is folded into the combined peak because it comes from the heap events, not from a
* snapshot: an observed block states heap as 0, so it is the only heap figure most logs give.
*/
function deriveGovernorLimits(snapshots, heapPeak) {
	const byNamespace = /* @__PURE__ */ new Map();
	let final = emptyLimits();
	let peak = emptyLimits();
	for (const { namespace, limits } of snapshots) {
		const previous = byNamespace.get(namespace);
		byNamespace.set(namespace, {
			final: copyLimits(limits),
			peak: previous ? maxLimits([previous.peak, limits]) : copyLimits(limits)
		});
		final = combineLimits(Array.from(byNamespace.values(), (nsLimits) => nsLimits.final));
		peak = maxLimits([peak, final]);
	}
	return {
		snapshots,
		final,
		peak: maxLimits([peak, heapOnly(heapPeak)]),
		byNamespace
	};
}
/**
* Every known governor-limit label → metric key. Covers the cumulative block ("Number of …" /
* "Maximum …"), the flow colon reports, and the flow running-total reports ("ms CPU time").
* Labels not present here are not tracked governor limits (e.g. FIELDS_DESCRIBES).
*/
const LIMIT_LABELS = /* @__PURE__ */ new Map([
	["Number of SOQL queries", "soqlQueries"],
	["Number of query rows", "queryRows"],
	["Number of SOSL queries", "soslQueries"],
	["Number of DML statements", "dmlStatements"],
	["Number of Publish Immediate DML", "publishImmediateDml"],
	["Number of DML rows", "dmlRows"],
	["Maximum CPU time", "cpuTime"],
	["Maximum heap size", "heapSize"],
	["Number of callouts", "callouts"],
	["Number of Email Invocations", "emailInvocations"],
	["Number of future calls", "futureCalls"],
	["Number of queueable jobs added to the queue", "queueableJobsAddedToQueue"],
	["Number of Mobile Apex push calls", "mobileApexPushCalls"],
	["SOQL queries", "soqlQueries"],
	["SOQL query rows", "queryRows"],
	["SOSL queries", "soslQueries"],
	["DML statements", "dmlStatements"],
	["DML rows", "dmlRows"],
	["CPU time in ms", "cpuTime"],
	["ms CPU time", "cpuTime"],
	["Heap size in bytes", "heapSize"],
	["Callouts", "callouts"],
	["Email invocations", "emailInvocations"],
	["Future calls", "futureCalls"],
	["Jobs in queue", "queueableJobsAddedToQueue"]
]);
/**
* Governor-limit codes for the single-line LIMIT_USAGE format. Non-governor codes
* (FIELDS_DESCRIBES, FIELDSETS_DESCRIBES, AGGS, SCRIPT_STATEMENTS) are intentionally omitted.
*/
const LIMIT_USAGE_CODES = /* @__PURE__ */ new Map([
	["SOQL", "soqlQueries"],
	["SOQL_ROWS", "queryRows"],
	["SOSL", "soslQueries"],
	["DML", "dmlStatements"],
	["DML_ROWS", "dmlRows"]
]);
/** Matches "<used> out of <limit>" or "<used>/<limit>". */
const USED_OF_RE = /(\d+)\s*(?:out of|\/)\s*(\d+)/;
/** Matches the "<count> <label>" head of a running-total line, e.g. "1 SOQL queries". */
const COUNT_LABEL_RE = /^(\d+)\s+(.+)$/;
function toInt(value) {
	return Number.parseInt(value, 10);
}
function used(metric, text) {
	if (!metric) return null;
	const match = USED_OF_RE.exec(text);
	return match ? {
		metric,
		used: toInt(match[1]),
		limit: toInt(match[2])
	} : null;
}
/**
* Parse a labelled limit line, e.g. "Number of SOQL queries: 8 out of 100" (cumulative block) or
* "SOQL queries: 0 out of 100" (flow). Returns null for untracked labels.
*/
function parseLabelledLimit(body) {
	const colon = body.indexOf(":");
	if (colon === -1) return null;
	return used(LIMIT_LABELS.get(body.slice(0, colon).trim()), body.slice(colon + 1));
}
/**
* Parse a running-total limit line, e.g. "1 SOQL queries, total 1 out of 100". Uses the reported
* running total as `used` and the leading count as `delta`. Returns null for untracked labels.
*/
function parseTotalLimit(body) {
	const comma = body.indexOf(",");
	if (comma === -1) return null;
	const head = body.slice(0, comma).trim();
	const [, count = "0", label = head] = COUNT_LABEL_RE.exec(head) ?? [];
	const observation = used(LIMIT_LABELS.get(label), body.slice(comma + 1));
	return observation ? {
		...observation,
		delta: toInt(count)
	} : null;
}
/**
* Parse a single-line LIMIT_USAGE record, e.g. code "SOQL", used "1", limit "100".
* Returns null for non-governor codes.
*/
function parseCodedLimit(code, usedValue, limit) {
	const metric = code ? LIMIT_USAGE_CODES.get(code) : void 0;
	return metric ? {
		metric,
		used: toInt(usedValue ?? "0"),
		limit: toInt(limit ?? "0")
	} : null;
}
//#endregion
//#region src/types.ts
const LOG_LEVEL = {
	/** Only the log header states this - a category the header switched off. */
	None: "NONE",
	Error: "ERROR",
	Warn: "WARN",
	Info: "INFO",
	Debug: "DEBUG",
	Fine: "FINE",
	Finer: "FINER",
	Finest: "FINEST"
};
/**
* Timeline display categories - our simplified/enhanced view of SF categories.
* Split Database → DML + SOQL, merge Flow + Workflow → Automation.
*/
const LOG_CATEGORY = {
	Apex: "Apex",
	System: "System",
	CodeUnit: "Code Unit",
	Automation: "Automation",
	DML: "DML",
	SOQL: "SOQL",
	Validation: "Validation",
	Callout: "Callout"
};
/** Readonly array of all category values (for building Sets, iterating, etc.) */
const ALL_LOG_CATEGORIES = Object.values(LOG_CATEGORY);
/** The label and unit for each governor metric. */
const LIMIT_METRIC = {
	soqlQueries: {
		key: "soqlQueries",
		label: "SOQL queries",
		unit: "count"
	},
	soslQueries: {
		key: "soslQueries",
		label: "SOSL queries",
		unit: "count"
	},
	queryRows: {
		key: "queryRows",
		label: "SOQL query rows",
		unit: "count"
	},
	dmlStatements: {
		key: "dmlStatements",
		label: "DML statements",
		unit: "count"
	},
	publishImmediateDml: {
		key: "publishImmediateDml",
		label: "Publish immediate DML",
		unit: "count"
	},
	dmlRows: {
		key: "dmlRows",
		label: "DML rows",
		unit: "count"
	},
	cpuTime: {
		key: "cpuTime",
		label: "CPU time",
		unit: "millisecond"
	},
	heapSize: {
		key: "heapSize",
		label: "Heap size",
		unit: "byte"
	},
	callouts: {
		key: "callouts",
		label: "Callouts",
		unit: "count"
	},
	emailInvocations: {
		key: "emailInvocations",
		label: "Email invocations",
		unit: "count"
	},
	futureCalls: {
		key: "futureCalls",
		label: "Future calls",
		unit: "count"
	},
	queueableJobsAddedToQueue: {
		key: "queueableJobsAddedToQueue",
		label: "Queueable jobs added to queue",
		unit: "count"
	},
	mobileApexPushCalls: {
		key: "mobileApexPushCalls",
		label: "Mobile Apex push calls",
		unit: "count"
	}
};
/** Readonly array of every metric's metadata, in display order (for iterating, building tables). */
const ALL_LIMIT_METRICS = Object.values(LIMIT_METRIC);
//#endregion
//#region src/LogEvents.ts
function zeroDuration() {
	const duration = {};
	duration.self = null;
	duration.total = null;
	duration.self = 0;
	duration.total = 0;
	return duration;
}
/**
* All log lines extend this base class.
*/
var LogEvent = class {
	logParser;
	parent = null;
	/**
	* All child nodes of the current node
	*/
	children = [];
	/**
	* The type of this log line from the log file e.g METHOD_ENTRY
	*/
	type = null;
	/**
	* The full raw text of this log line
	*/
	logLine = "";
	/**
	* A parsed version of the log line text useful for display in UIs
	*/
	text = "";
	/**
	* Should this log entry pull in following text lines (as the log entry can contain newlines)?
	*/
	acceptsText = false;
	/**
	* Is a method exit line?
	*/
	isExit = false;
	/**
	* Indicates whether the current log event could have children.
	* It is possible this is true but there are no defined exit events or children.
	*/
	isParent = false;
	/**
	* Whether the log event was truncated when the log ended, e,g no matching end event
	*/
	isTruncated = false;
	/**
	* Should the exitstamp be the timestamp of the next line?
	* These kind of lines can not be used as exit lines for anything othe than other pseudo exits.
	*/
	nextLineIsExit = false;
	/**
	* The line in the caller that this was called from.
	*/
	lineNumber = null;
	/**
	* The package namespace associated with this log line
	* @default default
	*/
	namespace = "";
	/**
	* Could match to a corresponding symbol in a file in the workspace?
	*/
	hasValidSymbols = false;
	/**
	* Extra description context
	*/
	suffix = null;
	/**
	* Does this line cause a discontinuity in the call stack? e.g an exception causing stack unwinding
	*/
	discontinuity = false;
	/**
	* The timestamp of this log line, in nanoseconds
	*/
	timestamp = 0;
	/**
	* A globally-unique, monotonically-increasing index assigned at construction
	* time within a single parse. Use this as a stable identifier when navigating
	* between views. Unlike `timestamp`, it is guaranteed unique per event.
	*/
	eventIndex = 0;
	/**
	* The timestamp when the node finished, in nanoseconds
	*/
	exitStamp = null;
	/**
	* The timeline display category this event belongs to.
	*/
	category = "";
	/**
	* The original Salesforce debug log category.
	*/
	debugCategory = "";
	/**
	* The log level at which this event is emitted (e.g. ERROR, FINE, FINEST).
	*/
	debugLevel = "";
	/**
	* The CPU type, e.g loading, method, custom
	*/
	cpuType = "";
	/**
	* The time spent: `self` is the net (wall) time spent in the node (when not inside children), and
	* `total` is the total (wall) time spent in the node.
	*/
	duration = zeroDuration();
	/**
	* Total + self row counts for DML: `self` excludes child nodes, `total` includes them.
	*/
	dmlRowCount = {
		self: 0,
		total: 0
	};
	/**
	* Total + self row counts for SOQL: `self` excludes child nodes, `total` includes them.
	*/
	soqlRowCount = {
		self: 0,
		total: 0
	};
	/**
	* Total + self row counts for SOSL: `self` excludes child nodes, `total` includes them.
	*/
	soslRowCount = {
		self: 0,
		total: 0
	};
	/**
	* DML operations (DML_BEGIN): `self` is the net number in this node, `total` includes child nodes.
	*/
	dmlCount = {
		self: 0,
		total: 0
	};
	/**
	* SOQL operations (SOQL_EXECUTE_BEGIN): `self` is the net number in this node, `total` includes
	* child nodes.
	*/
	soqlCount = {
		self: 0,
		total: 0
	};
	/**
	* SOSL operations (SOSL_EXECUTE_BEGIN): `self` is the net number in this node, `total` includes
	* child nodes.
	*/
	soslCount = {
		self: 0,
		total: 0
	};
	/**
	* Total + self counts for exceptions thrown (EXCEPTION_THROWN): `self` is the number thrown
	* directly by this node, and `total` includes child nodes.
	*
	* `self` is seeded on the EXCEPTION_THROWN leaf node (like DML/SOQL), so a method's
	* `thrownCount.self` is always 0 (the throw is a child, not the method itself). Because
	* only methods are hoverable on the timeline, `self` is deliberately omitted from the
	* Throws tooltip row, because it would only ever read "(self 0)". The field keeps the SelfTotal
	* shape for consistency with the other metrics and so the leaf carries `self: 1`.
	*/
	thrownCount = {
		self: 0,
		total: 0
	};
	/**
	* Signed NET heap bytes (alloc − free) for HEAP_ALLOCATE / BULK_HEAP_ALLOCATE / HEAP_DEALLOCATE.
	* A `HEAP_DEALLOCATE`, or a negative `HEAP_ALLOCATE`, is a deallocation, so this is signed: `+`
	* grows the heap, `−` is net cleanup, `~0` is neutral ("allocated then freed, no lasting
	* footprint"). This is the primary "does this path retain heap" metric. It is NOT the churn
	* volume (see {@link heapGross}) nor the governor-comparable peak (see {@link heapPeak}).
	*
	* `self` is the net directly in this node's own body: seeded as `bytes` on each allocation
	* leaf, and (in `aggregateTotals`) summed onto the enclosing method from its direct leaf
	* children only, so a method's `self` excludes allocations in sub-methods. `total` is the
	* net across this node and all descendants.
	*/
	heapAllocated = {
		self: 0,
		total: 0
	};
	/**
	* GROSS heap bytes allocated (positive HEAP_ALLOCATE only; frees ignored): the churn / GC
	* pressure a path creates regardless of whether it frees. Distinct from {@link heapAllocated}
	* (net) and {@link heapPeak} (max live): an allocate-then-free loop has net ≈ 0 and a small
	* peak but a large gross. Same self/total aggregation as {@link heapAllocated}.
	*/
	heapGross = {
		self: 0,
		total: 0
	};
	/**
	* Peak live heap (bytes) for this node's subtree: the highest running live-heap total reached
	* at a heap leaf below it, clamped at 0. Always ≥ 0 and composes (child ≤ parent ≤ root), so
	* the root equals the transaction peak. This is the heap number comparable to the heap
	* governor limit.
	*/
	heapPeak = 0;
	/**
	* The line types which would legitimately end this method
	*/
	exitTypes = [];
	constructor(parser, parts) {
		this.logParser = parser;
		this.eventIndex = parser.eventsById.length;
		parser.eventsById.push(this);
		const [timeData, type] = parts;
		if (type) this.text = this.type = type;
		if (timeData) this.timestamp = this.parseTimestamp(timeData);
	}
	recalculateDurations() {
		if (this.exitStamp) this.duration.total = this.duration.self = this.exitStamp - this.timestamp;
	}
	/**
	* Seeds this heap-allocation leaf's net/gross/peak metrics from a signed byte delta
	* (negative = deallocation) and advances the parser's running live-heap total.
	*/
	seedHeapLeaf(parser, bytes) {
		this.heapAllocated.self = this.heapAllocated.total = bytes || 0;
		this.heapGross.self = this.heapGross.total = bytes > 0 ? bytes : 0;
		this.heapPeak = parser.trackHeapAllocation(bytes);
	}
	parseTimestamp(text) {
		const start = text.indexOf("(");
		if (start !== -1) return Number(text.slice(start + 1, -1));
		throw new Error(`Unable to parse timestamp: '${text}'`);
	}
	parseLineNumber(text) {
		switch (true) {
			case text === "[EXTERNAL]": return "EXTERNAL";
			case !!text: {
				const lineNumberStr = text.slice(1, -1);
				if (lineNumberStr) return Number(lineNumberStr);
				throw new Error(`Unable to parse line number: '${text}'`);
			}
			default: return 0;
		}
	}
};
var DurationLogEvent = class extends LogEvent {
	isParent = true;
	constructor(parser, parts, exitTypes, category, cpuType) {
		super(parser, parts);
		this.exitTypes = exitTypes;
		this.category = category;
		this.cpuType = cpuType;
	}
};
var BasicLogLine = class extends LogEvent {};
var BasicExitLine = class extends LogEvent {
	isExit = true;
};
/**
* This export class represents the single root node for the node tree.
* It is a "pseudo" node and not present in the log.
* Since it has children it extends "Method".
*/
var ApexLog = class extends LogEvent {
	type = null;
	text = "LOG_ROOT";
	timestamp = 0;
	exitStamp = 0;
	exitTypes = [];
	category = "";
	cpuType = "";
	/**
	* The size of the log, in UTF-8 bytes. Not the string length: a non-ASCII character costs more
	* than one byte.
	*/
	size = 0;
	/**
	* The Apex Debug Logging Levels for the current log: known categories with a valid level only.
	* See `debugLevelSettings` for every entry as the log stated it.
	*/
	debugLevels = {};
	/**
	* Every entry of the settings line, verbatim and in log order, including a category the parser
	* does not know. Empty when the log has no settings line.
	*/
	debugLevelSettings = [];
	/**
	* All the namespaces that appear in this log.
	*/
	namespaces = [];
	/**
	* Any issues within the log, such as cpu time exceeded or max log size reached.
	*/
	logIssues = [];
	/**
	* Any issues that occurred during the parsing of the log, such as an unrecognized log event type.
	*/
	parsingErrors = [];
	/**
	* Every code unit directly on the root or directly under an `EXECUTION_STARTED`, in log order. The
	* first can be a short platform step, such as `FutureHandler - state load` before the real work.
	* Each one states its `timestamp` and `duration`, so a caller can choose which to name, e.g. the
	* longest. When the log drops an exit line, one entry point can hold a later one, truncated or not,
	* so do not sum their durations. Empty when no code unit sits at either place.
	*/
	entryPoints = [];
	/** Who ran the transaction, from the `USER_INFO` header line. Null when it states no user. */
	userInfo = null;
	/**
	* Every region the platform did not write in full, and the byte total it reported.
	* `isTruncated` on this root is true when there is at least one region.
	*/
	truncation = {
		regions: [],
		totalSkippedBytes: 0
	};
	/**
	* Events the parser could not terminate because the log stopped inside them, innermost frame
	* first. Populated whenever the log ends mid-frame, which is not on its own evidence that the
	* platform dropped content, so it can be non-empty while `isTruncated` is false.
	*/
	truncatedEvents = [];
	governorLimits = emptyGovernorLimits();
	/**
	* The wall-clock time of the first event, in milliseconds since midnight.
	* Parsed from the `HH:MM:SS.f` portion of the first log line.
	* Null if no wall-clock time could be parsed.
	*/
	startTime = null;
	/**
	* Flat lookup of every parsed event by its `eventIndex`. Populated by the
	* parser; used by cross-view navigation to resolve a stable id back to its
	* `LogEvent` without relying on (non-unique) timestamps.
	*/
	eventsById = [];
	/**
	* Every exception event (EXCEPTION_THROWN, FATAL_ERROR) in log order.
	* Used by the timeline to mark where exceptions were thrown.
	*/
	exceptions = [];
	/**
	* The endtime with nodes of 0 duration excluded
	*/
	executionEndTime = 0;
	constructor(parser) {
		super(parser, []);
	}
	setTimes() {
		const firstChild = this.children.find((child) => {
			return child.timestamp;
		});
		this.timestamp = firstChild?.timestamp || 0;
		if (firstChild?.logLine) this.startTime = parseWallClockTime(firstChild.logLine);
		let endTime;
		const reverseLen = this.children.length - 1;
		for (let i = reverseLen; i >= 0; i--) {
			const child = this.children[i];
			if (child?.exitStamp) {
				endTime ??= child.exitStamp;
				if (child.duration) {
					this.executionEndTime = child.exitStamp;
					break;
				}
			}
			endTime ??= child?.timestamp;
		}
		this.exitStamp = endTime || 0;
		this.recalculateDurations();
	}
};
function parseObjectNamespace(text) {
	if (!text) return "";
	const sep = text.indexOf("__");
	if (sep === -1) return "default";
	return text.slice(0, sep);
}
function parseVfNamespace(text) {
	const sep = text.indexOf("__");
	if (sep === -1) return "default";
	const firstSlash = text.indexOf("/");
	if (firstSlash === -1) return "default";
	const secondSlash = text.indexOf("/", firstSlash + 1);
	if (secondSlash < 0) return "default";
	return text.substring(secondSlash + 1, sep);
}
/**
* Parses the wall-clock time from a log line's timestamp portion.
* Log lines start with `HH:MM:SS.f (nanoseconds)|...`
* Returns milliseconds since midnight, or null if parsing fails.
*/
function parseWallClockTime(logLine) {
	const match = /^(\d{1,2}):(\d{2}):(\d{2})\.(\d+)\s/.exec(logLine);
	if (!match) return null;
	const hours = Number(match[1]);
	const minutes = Number(match[2]);
	const seconds = Number(match[3]);
	const fraction = Number(match[4].padEnd(3, "0"));
	return (hours * 3600 + minutes * 60 + seconds) * 1e3 + fraction;
}
function parseRows(text) {
	if (!text) return 0;
	const rowCount = text.slice(text.indexOf("Rows:") + 5);
	if (rowCount) return Number(rowCount);
	throw new Error(`Unable to parse row count: '${text}'`);
}
/** Parse a byte count from a "Bytes:N" fragment (e.g. "Bytes:152" → 152, "Bytes:-4" → -4). */
function parseBytes(fragment) {
	return fragment?.startsWith("Bytes:") ? Number(fragment.slice(6)) || 0 : 0;
}
function splitTrailingFields(text, count) {
	const parts = text.split("|");
	if (parts.length <= count) return null;
	const fields = parts.splice(-count);
	if (fields.some((field) => field.includes("\n"))) return null;
	return [parts.join("|").trimEnd(), ...fields];
}
const salesforceIdPattern = /^[a-zA-Z0-9]{15}(?:[a-zA-Z0-9]{3})?$/;
var BulkHeapAllocateLine = class extends LogEvent {
	debugLevel = LOG_LEVEL.Finest;
	debugCategory = "apexCode";
	/** Bytes allocated by this bulk allocation (from the "Bytes:N" fragment). */
	bytes = 0;
	constructor(parser, parts) {
		super(parser, parts);
		this.text = parts[2] || "";
		this.bytes = parseBytes(parts[2]);
		this.seedHeapLeaf(parser, this.bytes);
	}
};
var CalloutRequestLine = class extends DurationLogEvent {
	debugCategory = "callout";
	debugLevel = LOG_LEVEL.Info;
	constructor(parser, parts) {
		super(parser, parts, ["CALLOUT_RESPONSE"], LOG_CATEGORY.Callout, "free");
		this.text = parts[3] ?? "";
		this.lineNumber = this.parseLineNumber(parts[2]);
	}
};
var CalloutResponseLine = class extends LogEvent {
	debugLevel = LOG_LEVEL.Info;
	debugCategory = "callout";
	isExit = true;
	constructor(parser, parts) {
		super(parser, parts);
		this.text = parts[3] ?? "";
		this.lineNumber = this.parseLineNumber(parts[2]);
	}
};
var NamedCredentialRequestLine = class extends LogEvent {
	debugCategory = "callout";
	debugLevel = LOG_LEVEL.Info;
	constructor(parser, parts) {
		super(parser, parts);
		this.text = `${parts[3]} : ${parts[4]} : ${parts[5]} : ${parts[6]}`;
	}
};
var NamedCredentialResponseLine = class extends LogEvent {
	debugCategory = "callout";
	debugLevel = LOG_LEVEL.Info;
	constructor(parser, parts) {
		super(parser, parts);
		this.text = `${parts[2]}`;
	}
};
var NamedCredentialResponseDetailLine = class extends LogEvent {
	debugCategory = "callout";
	debugLevel = LOG_LEVEL.Finer;
	constructor(parser, parts) {
		super(parser, parts);
		this.text = `${parts[3]} : ${parts[4]} ${parts[5]} : ${parts[6]} ${parts[7]}`;
	}
};
var ConstructorEntryLine = class extends DurationLogEvent {
	debugCategory = "apexCode";
	debugLevel = LOG_LEVEL.Fine;
	hasValidSymbols = true;
	suffix = " (constructor)";
	constructor(parser, parts) {
		super(parser, parts, ["CONSTRUCTOR_EXIT"], LOG_CATEGORY.Apex, "method");
		this.lineNumber = this.parseLineNumber(parts[2]);
		const [, , , , args, className] = parts;
		this.text = className + (args ? args.substring(args.lastIndexOf("(")) : "");
		const possibleNS = this._parseConstructorNamespace(className || "");
		if (possibleNS) this.namespace = possibleNS;
	}
	_parseConstructorNamespace(className) {
		let possibleNs = className.slice(0, className.indexOf("."));
		if (this.logParser.namespaces.has(possibleNs)) return possibleNs;
		const constructorParts = (className ?? "").split(".");
		possibleNs = constructorParts[0] || "";
		if (constructorParts.length === 3) return possibleNs;
		return "";
	}
};
var ConstructorExitLine = class extends LogEvent {
	debugLevel = LOG_LEVEL.Fine;
	debugCategory = "apexCode";
	isExit = true;
	constructor(parser, parts) {
		super(parser, parts);
		this.lineNumber = this.parseLineNumber(parts[2]);
	}
};
var EmailQueueLine = class extends LogEvent {
	debugLevel = LOG_LEVEL.Info;
	debugCategory = "apexCode";
	acceptsText = true;
	constructor(parser, parts) {
		super(parser, parts);
		this.lineNumber = this.parseLineNumber(parts[2]);
	}
};
var MethodEntryLine = class extends DurationLogEvent {
	debugCategory = "apexCode";
	debugLevel = LOG_LEVEL.Fine;
	hasValidSymbols = true;
	constructor(parser, parts) {
		super(parser, parts, ["METHOD_EXIT"], LOG_CATEGORY.Apex, "method");
		const [, , lineNumber, , methodName] = parts;
		this.lineNumber = this.parseLineNumber(lineNumber);
		this.text = methodName || this.type || this.text;
		if (this.text.startsWith("System.Type.forName(")) this.cpuType = "loading";
		else {
			const possibleNs = this._parseMethodNamespace(methodName);
			if (possibleNs) this.namespace = possibleNs;
		}
	}
	onEnd(end, _stack) {
		if (end.namespace && !end.text.endsWith(")")) this.namespace = end.namespace;
	}
	_parseMethodNamespace(methodName) {
		if (!methodName) return "";
		const methodBracketIndex = methodName.indexOf("(");
		if (methodBracketIndex === -1) return "";
		const nsSeparator = methodName.indexOf(".");
		if (nsSeparator === -1) return "";
		const possibleNs = methodName.slice(0, nsSeparator);
		if (this.logParser.namespaces.has(possibleNs)) return possibleNs;
		const methodNameParts = methodName.slice(0, methodBracketIndex)?.split(".");
		if (methodNameParts.length === 4) return methodNameParts[0] ?? "";
		else if (methodNameParts.length === 2) return "default";
		return "";
	}
};
var MethodExitLine = class extends LogEvent {
	debugLevel = LOG_LEVEL.Fine;
	debugCategory = "apexCode";
	isExit = true;
	constructor(parser, parts) {
		super(parser, parts);
		this.lineNumber = this.parseLineNumber(parts[2]);
		this.text = parts[4] ?? parts[3] ?? this.text;
		if (!this.text.endsWith(")")) {
			const index = this.text.indexOf(".");
			if (index !== -1) this.namespace = this.text.slice(0, index);
		}
	}
};
var SystemConstructorEntryLine = class extends DurationLogEvent {
	debugCategory = "system";
	debugLevel = LOG_LEVEL.Fine;
	suffix = " (system constructor)";
	constructor(parser, parts) {
		super(parser, parts, ["SYSTEM_CONSTRUCTOR_EXIT"], LOG_CATEGORY.System, "method");
		this.lineNumber = this.parseLineNumber(parts[2]);
		this.text = parts[3] || "";
	}
};
var SystemConstructorExitLine = class extends LogEvent {
	debugLevel = LOG_LEVEL.Fine;
	debugCategory = "system";
	isExit = true;
	constructor(parser, parts) {
		super(parser, parts);
		this.lineNumber = this.parseLineNumber(parts[2]);
	}
};
var SystemMethodEntryLine = class extends DurationLogEvent {
	debugCategory = "system";
	debugLevel = LOG_LEVEL.Fine;
	constructor(parser, parts) {
		super(parser, parts, ["SYSTEM_METHOD_EXIT"], LOG_CATEGORY.System, "method");
		this.lineNumber = this.parseLineNumber(parts[2]);
		this.text = parts[3] || "";
	}
};
var SystemMethodExitLine = class extends LogEvent {
	debugLevel = LOG_LEVEL.Fine;
	debugCategory = "system";
	isExit = true;
	constructor(parser, parts) {
		super(parser, parts);
		this.lineNumber = this.parseLineNumber(parts[2]);
	}
};
var CodeUnitStartedLine = class extends DurationLogEvent {
	debugCategory = "apexCode";
	debugLevel = LOG_LEVEL.Error;
	suffix = " (code unit)";
	codeUnitType = "";
	constructor(parser, parts) {
		super(parser, parts, ["CODE_UNIT_FINISHED"], LOG_CATEGORY.CodeUnit, "custom");
		const typeString = parts[5] || parts[4] || parts[3] || "";
		let sepIndex = typeString.indexOf(":");
		if (sepIndex === -1) sepIndex = typeString.indexOf("/");
		this.codeUnitType = sepIndex !== -1 ? typeString.slice(0, sepIndex) : "";
		const name = parts[4] || parts[3] || this.codeUnitType || "";
		switch (this.codeUnitType) {
			case "EventService":
				this.cpuType = "method";
				this.namespace = parseObjectNamespace(typeString.slice(sepIndex + 1));
				this.text = name;
				break;
			case "Validation":
				this.cpuType = "custom";
				this.text = name;
				break;
			case "Workflow":
				this.cpuType = "custom";
				this.text = name;
				break;
			case "Flow":
				this.cpuType = "custom";
				this.text = name;
				break;
			case "VF":
				this.cpuType = "method";
				this.namespace = parseVfNamespace(name);
				this.text = name;
				break;
			case "apex": {
				this.cpuType = "method";
				const namespaceIndex = name.indexOf(".");
				this.namespace = namespaceIndex !== -1 ? name.slice(name.indexOf("apex://") + 7, namespaceIndex) : "default";
				this.text = name;
				break;
			}
			case "__sfdc_trigger": {
				this.cpuType = "method";
				this.text = name || parts[4] || "";
				const triggerParts = parts[5]?.split("/") || "";
				this.namespace = triggerParts.length === 3 ? triggerParts[1] || "default" : "default";
				break;
			}
			default: {
				this.cpuType = "method";
				this.text = name;
				const openBracket = name.lastIndexOf("(");
				const methodName = openBracket !== -1 ? name.slice(0, openBracket + 1).split(".") : name.split(".");
				if (methodName.length === 3 || methodName.length === 2 && !methodName[1]?.endsWith("(")) this.namespace = methodName[0] || "default";
				break;
			}
		}
		this.namespace ||= "default";
		parser.codeUnits.push(this);
	}
};
var CodeUnitFinishedLine = class extends LogEvent {
	debugLevel = LOG_LEVEL.Error;
	debugCategory = "apexCode";
	isExit = true;
	constructor(parser, parts) {
		super(parser, parts);
		this.text = parts[2] || "";
	}
};
var VFApexCallStartLine = class extends DurationLogEvent {
	debugCategory = "visualforce";
	debugLevel = LOG_LEVEL.Fine;
	hasValidSymbols = true;
	suffix = " (VF APEX)";
	invalidClasses = [
		"pagemessagescomponentcontroller",
		"pagemessagecomponentcontroller",
		"severitymessages"
	];
	constructor(parser, parts) {
		super(parser, parts, ["VF_APEX_CALL_END"], LOG_CATEGORY.Apex, "method");
		this.lineNumber = this.parseLineNumber(parts[2]);
		const classText = parts[5] || parts[3] || "";
		let methodtext = parts[4] || "";
		if (!methodtext && (!classText.includes(" ") || this.invalidClasses.some((invalidCls) => classText.toLowerCase().includes(invalidCls)))) {
			this.exitTypes = [];
			this.hasValidSymbols = false;
		} else if (methodtext) {
			const methodIndex = methodtext.indexOf("(");
			const constructorIndex = methodtext.indexOf("<init>");
			if (methodIndex > -1) methodtext = "." + methodtext.substring(methodIndex).slice(1, -1) + "()";
			else if (constructorIndex > -1) methodtext = methodtext.substring(constructorIndex + 6) + "()";
			else methodtext = "." + methodtext;
		}
		this.text = classText + methodtext;
	}
};
var VFApexCallEndLine = class extends LogEvent {
	debugLevel = LOG_LEVEL.Fine;
	debugCategory = "visualforce";
	isExit = true;
	constructor(parser, parts) {
		super(parser, parts);
		this.text = parts[2] || "";
	}
};
var VFDeserializeViewstateBeginLine = class extends DurationLogEvent {
	debugCategory = "visualforce";
	debugLevel = LOG_LEVEL.Info;
	constructor(parser, parts) {
		super(parser, parts, ["VF_DESERIALIZE_VIEWSTATE_END"], LOG_CATEGORY.System, "method");
	}
};
var VFFormulaStartLine = class extends DurationLogEvent {
	debugCategory = "visualforce";
	debugLevel = LOG_LEVEL.Finer;
	suffix = " (VF FORMULA)";
	constructor(parser, parts) {
		super(parser, parts, ["VF_EVALUATE_FORMULA_END"], LOG_CATEGORY.System, "custom");
		this.text = parts[3] || "";
	}
};
var VFFormulaEndLine = class extends LogEvent {
	debugCategory = "visualforce";
	debugLevel = LOG_LEVEL.Finer;
	isExit = true;
	constructor(parser, parts) {
		super(parser, parts);
		this.text = parts[2] || "";
	}
};
var VFSeralizeViewStateStartLine = class extends DurationLogEvent {
	debugCategory = "visualforce";
	debugLevel = LOG_LEVEL.Info;
	constructor(parser, parts) {
		super(parser, parts, ["VF_SERIALIZE_VIEWSTATE_END"], LOG_CATEGORY.System, "method");
	}
};
var VFPageMessageLine = class extends LogEvent {
	debugCategory = "apexCode";
	debugLevel = LOG_LEVEL.Info;
	acceptsText = true;
	constructor(parser, parts) {
		super(parser, parts);
		this.text = parts[2] || "";
	}
};
var DMLBeginLine = class extends DurationLogEvent {
	debugCategory = "database";
	debugLevel = LOG_LEVEL.Info;
	namespace = "default";
	/** The SObject the DML targets (e.g. `Account`), from the `Type:` field. Null if absent. */
	sObjectType = null;
	constructor(parser, parts) {
		super(parser, parts, ["DML_END"], LOG_CATEGORY.DML, "free");
		this.dmlCount.self = this.dmlCount.total = 1;
		this.lineNumber = this.parseLineNumber(parts[2]);
		this.text = "DML " + parts[3] + " " + parts[4];
		const typePart = parts[4];
		if (typePart?.startsWith("Type:")) this.sObjectType = typePart.slice(5);
		const rowCountString = parts[5];
		this.dmlRowCount.total = this.dmlRowCount.self = rowCountString ? parseRows(rowCountString) : 0;
	}
};
var DMLEndLine = class extends LogEvent {
	debugLevel = LOG_LEVEL.Info;
	debugCategory = "database";
	isExit = true;
	constructor(parser, parts) {
		super(parser, parts);
		this.lineNumber = this.parseLineNumber(parts[2]);
	}
};
var IdeasQueryExecuteLine = class extends LogEvent {
	debugLevel = LOG_LEVEL.Finest;
	debugCategory = "database";
	constructor(parser, parts) {
		super(parser, parts);
		this.lineNumber = this.parseLineNumber(parts[2]);
	}
};
var SOQLExecuteBeginLine = class extends DurationLogEvent {
	debugCategory = "database";
	debugLevel = LOG_LEVEL.Info;
	aggregations = 0;
	children = [];
	constructor(parser, parts) {
		super(parser, parts, ["SOQL_EXECUTE_END"], LOG_CATEGORY.SOQL, "free");
		this.soqlCount.self = this.soqlCount.total = 1;
		this.lineNumber = this.parseLineNumber(parts[2]);
		const [, , , aggregations, soqlString] = parts;
		const aggregationText = aggregations || "";
		if (aggregationText) {
			const aggregationIndex = aggregationText.indexOf("Aggregations:");
			this.aggregations = Number(aggregationText.slice(aggregationIndex + 13));
		}
		this.text = soqlString || "";
	}
	onEnd(end, _stack) {
		this.soqlRowCount.total = this.soqlRowCount.self = end.soqlRowCount.total;
	}
};
var SOQLExecuteEndLine = class extends LogEvent {
	debugLevel = LOG_LEVEL.Info;
	debugCategory = "database";
	isExit = true;
	constructor(parser, parts) {
		super(parser, parts);
		this.lineNumber = this.parseLineNumber(parts[2]);
		this.soqlRowCount.total = this.soqlRowCount.self = parseRows(parts[3] || "");
	}
};
var SOQLExecuteExplainLine = class extends LogEvent {
	debugLevel = LOG_LEVEL.Finest;
	debugCategory = "database";
	cardinality = null;
	fields = null;
	leadingOperationType = null;
	relativeCost = null;
	sObjectCardinality = null;
	sObjectType = null;
	constructor(parser, parts) {
		super(parser, parts);
		this.lineNumber = this.parseLineNumber(parts[2]);
		const queryPlanDetails = parts[3] || "";
		this.text = queryPlanDetails;
		const queryplanParts = queryPlanDetails.split("],");
		if (queryplanParts.length > 1) {
			const planExplain = queryplanParts[0] || "";
			const [cardinalityText, sobjCardinalityText, costText] = (queryplanParts[1] || "").split(",");
			const onIndex = planExplain.indexOf(" on");
			this.leadingOperationType = planExplain.slice(0, onIndex);
			const colonIndex = planExplain.indexOf(" :");
			this.sObjectType = planExplain.slice(onIndex + 4, colonIndex);
			const fieldsAsString = planExplain.slice(planExplain.indexOf("[") + 1).replace(/\s+/g, "");
			this.fields = fieldsAsString === "" ? [] : fieldsAsString.split(",");
			this.cardinality = cardinalityText ? Number(cardinalityText.slice(cardinalityText.indexOf("cardinality: ") + 13)) : null;
			this.sObjectCardinality = sobjCardinalityText ? Number(sobjCardinalityText.slice(sobjCardinalityText.indexOf("sobjectCardinality: ") + 20)) : null;
			this.relativeCost = costText ? Number(costText.slice(costText.indexOf("relativeCost ") + 13)) : null;
		}
	}
};
var SOSLExecuteBeginLine = class extends DurationLogEvent {
	debugCategory = "database";
	debugLevel = LOG_LEVEL.Info;
	constructor(parser, parts) {
		super(parser, parts, ["SOSL_EXECUTE_END"], LOG_CATEGORY.SOQL, "free");
		this.soslCount.self = this.soslCount.total = 1;
		this.lineNumber = this.parseLineNumber(parts[2]);
		this.text = `SOSL: ${parts[3]}`;
	}
	onEnd(end, _stack) {
		this.soslRowCount.total = this.soslRowCount.self = end.soslRowCount.total;
	}
};
var SOSLExecuteEndLine = class extends LogEvent {
	debugLevel = LOG_LEVEL.Info;
	debugCategory = "database";
	isExit = true;
	constructor(parser, parts) {
		super(parser, parts);
		this.lineNumber = this.parseLineNumber(parts[2]);
		this.soslRowCount.total = this.soslRowCount.self = parseRows(parts[3] || "");
	}
};
var HeapAllocateLine = class extends LogEvent {
	debugLevel = LOG_LEVEL.Finer;
	debugCategory = "apexCode";
	/** Bytes allocated by this line. Example: "|HEAP_ALLOCATE|[84]|Bytes:152" → 152. */
	bytes = 0;
	constructor(parser, parts) {
		super(parser, parts);
		this.lineNumber = this.parseLineNumber(parts[2]);
		this.text = parts[3] || "";
		this.bytes = parseBytes(parts[3]);
		this.seedHeapLeaf(parser, this.bytes);
	}
};
var HeapDeallocateLine = class extends LogEvent {
	debugLevel = LOG_LEVEL.Finer;
	debugCategory = "apexCode";
	/** Bytes deallocated by this line (from the "Bytes:N" fragment, when present). */
	bytes = 0;
	constructor(parser, parts) {
		super(parser, parts);
		this.lineNumber = this.parseLineNumber(parts[2]);
		this.bytes = parseBytes(parts[3]);
		this.seedHeapLeaf(parser, -this.bytes);
	}
};
var StatementExecuteLine = class extends LogEvent {
	debugLevel = LOG_LEVEL.Finer;
	debugCategory = "apexCode";
	constructor(parser, parts) {
		super(parser, parts);
		this.lineNumber = this.parseLineNumber(parts[2]);
	}
};
var VariableScopeBeginLine = class extends LogEvent {
	debugLevel = LOG_LEVEL.Finest;
	debugCategory = "apexCode";
	constructor(parser, parts) {
		super(parser, parts);
		this.lineNumber = this.parseLineNumber(parts[2]);
		this.text = parts.slice(3).join(" | ");
	}
};
var VariableAssignmentLine = class extends LogEvent {
	debugLevel = LOG_LEVEL.Finest;
	debugCategory = "apexCode";
	constructor(parser, parts) {
		super(parser, parts);
		this.lineNumber = this.parseLineNumber(parts[2]);
		this.text = parts.slice(3).join(" | ");
	}
};
var UserInfoLine = class extends LogEvent {
	debugLevel = LOG_LEVEL.Error;
	debugCategory = "apexCode";
	constructor(parser, parts) {
		super(parser, parts);
		this.lineNumber = this.parseLineNumber(parts[2]);
		this.text = [parts[3], parts[4]].filter(Boolean).join(" ");
	}
};
var UserDebugLine = class extends LogEvent {
	debugLevel = LOG_LEVEL.Debug;
	debugCategory = "apexCode";
	acceptsText = true;
	constructor(parser, parts) {
		super(parser, parts);
		this.lineNumber = this.parseLineNumber(parts[2]);
		this.text = parts.slice(3).join(" | ");
	}
};
var CumulativeLimitUsageLine = class extends DurationLogEvent {
	debugCategory = "apexProfiling";
	debugLevel = LOG_LEVEL.Info;
	namespace = "default";
	constructor(parser, parts) {
		super(parser, parts, ["CUMULATIVE_LIMIT_USAGE_END"], LOG_CATEGORY.System, "system");
	}
};
var CumulativeProfilingLine = class extends LogEvent {
	debugLevel = LOG_LEVEL.Fine;
	debugCategory = "apexProfiling";
	acceptsText = true;
	namespace = "default";
	constructor(parser, parts) {
		super(parser, parts);
		this.text = parts[2] + " " + (parts[3] ?? "");
	}
};
var CumulativeProfilingBeginLine = class extends DurationLogEvent {
	debugCategory = "apexProfiling";
	debugLevel = LOG_LEVEL.Fine;
	namespace = "default";
	constructor(parser, parts) {
		super(parser, parts, ["CUMULATIVE_PROFILING_END"], LOG_CATEGORY.System, "custom");
	}
};
var LimitUsageLine = class extends LogEvent {
	debugCategory = "apexProfiling";
	debugLevel = LOG_LEVEL.Finest;
	namespace = "default";
	/**
	* Governor-limit observation parsed from this line, or null for non-governor codes.
	* Example: "|LIMIT_USAGE|[89]|SOQL|1|100" → { metric: 'soqlQueries', used: 1, limit: 100 }.
	*/
	limitUsage = null;
	constructor(parser, parts) {
		super(parser, parts);
		this.lineNumber = this.parseLineNumber(parts[2]);
		this.text = parts[3] + " " + parts[4] + " out of " + parts[5];
		this.limitUsage = parseCodedLimit(parts[3], parts[4], parts[5]);
	}
};
var LimitUsageForNSLine = class extends LogEvent {
	debugCategory = "apexProfiling";
	debugLevel = LOG_LEVEL.Finest;
	constructor(parser, parts) {
		super(parser, parts);
		this.acceptsText = true;
		this.text = parts[2] || "";
		this.namespace = this.text.replace(/[()]/g, "") || "default";
	}
	onAfter(parser, _next) {
		const cleanedText = this.text.replace(/^\s+/gm, "").replaceAll("******* CLOSE TO LIMIT", "").replaceAll(" out of ", "/");
		this.text = cleanedText;
		const limits = emptyLimits();
		for (const line of cleanedText.split("\n")) {
			const observation = parseLabelledLimit(line);
			if (observation) limits[observation.metric] = toLimitValue(observation.used, observation.limit);
		}
		parser.governorSnapshots.push({
			timestamp: this.timestamp,
			namespace: this.namespace,
			limits
		});
	}
};
var NBANodeBegin = class extends DurationLogEvent {
	debugCategory = "nba";
	debugLevel = LOG_LEVEL.Fine;
	constructor(parser, parts) {
		super(parser, parts, ["NBA_NODE_END"], LOG_CATEGORY.Automation, "method");
		this.text = parts.slice(2).join(" | ");
	}
};
var NBANodeDetail = class extends LogEvent {
	debugLevel = LOG_LEVEL.Fine;
	debugCategory = "nba";
	constructor(parser, parts) {
		super(parser, parts);
		this.text = parts.slice(2).join(" | ");
	}
};
var NBANodeEnd = class extends LogEvent {
	debugLevel = LOG_LEVEL.Fine;
	debugCategory = "nba";
	isExit = true;
	constructor(parser, parts) {
		super(parser, parts);
		this.text = parts.slice(2).join(" | ");
	}
};
var NBANodeError = class extends LogEvent {
	debugLevel = LOG_LEVEL.Error;
	debugCategory = "nba";
	constructor(parser, parts) {
		super(parser, parts);
		this.text = parts.slice(2).join(" | ");
	}
};
var NBAOfferInvalid = class extends LogEvent {
	debugLevel = LOG_LEVEL.Fine;
	debugCategory = "nba";
	constructor(parser, parts) {
		super(parser, parts);
		this.text = parts.slice(2).join(" | ");
	}
};
var NBAStrategyBegin = class extends DurationLogEvent {
	debugCategory = "nba";
	debugLevel = LOG_LEVEL.Fine;
	constructor(parser, parts) {
		super(parser, parts, ["NBA_STRATEGY_END"], LOG_CATEGORY.Automation, "method");
		this.text = parts.slice(2).join(" | ");
	}
};
var NBAStrategyEnd = class extends LogEvent {
	debugLevel = LOG_LEVEL.Fine;
	debugCategory = "nba";
	isExit = true;
	constructor(parser, parts) {
		super(parser, parts);
		this.text = parts.slice(2).join(" | ");
	}
};
var NBAStrategyError = class extends LogEvent {
	debugLevel = LOG_LEVEL.Error;
	debugCategory = "nba";
	constructor(parser, parts) {
		super(parser, parts);
		this.text = parts.slice(2).join(" | ");
	}
};
var PushTraceFlagsLine = class extends LogEvent {
	debugLevel = LOG_LEVEL.Info;
	debugCategory = "system";
	constructor(parser, parts) {
		super(parser, parts);
		this.lineNumber = this.parseLineNumber(parts[2]);
		this.text = parts[4] + ", line:" + this.lineNumber + " - " + parts[5];
	}
};
var PopTraceFlagsLine = class extends LogEvent {
	debugLevel = LOG_LEVEL.Info;
	debugCategory = "system";
	constructor(parser, parts) {
		super(parser, parts);
		this.lineNumber = this.parseLineNumber(parts[2]);
		this.text = parts[4] + ", line:" + this.lineNumber + " - " + parts[5];
	}
};
var QueryMoreBeginLine = class extends DurationLogEvent {
	debugCategory = "database";
	debugLevel = LOG_LEVEL.Info;
	constructor(parser, parts) {
		super(parser, parts, ["QUERY_MORE_END"], LOG_CATEGORY.SOQL, "custom");
		this.lineNumber = this.parseLineNumber(parts[2]);
		this.text = `line: ${this.lineNumber}`;
	}
};
var QueryMoreEndLine = class extends LogEvent {
	debugLevel = LOG_LEVEL.Info;
	debugCategory = "database";
	isExit = true;
	constructor(parser, parts) {
		super(parser, parts);
		this.lineNumber = this.parseLineNumber(parts[2]);
		this.text = `line: ${this.lineNumber}`;
	}
};
var QueryMoreIterationsLine = class extends LogEvent {
	debugLevel = LOG_LEVEL.Info;
	debugCategory = "database";
	constructor(parser, parts) {
		super(parser, parts);
		this.lineNumber = this.parseLineNumber(parts[2]);
		this.text = `line: ${this.lineNumber}, iterations:${parts[3]}`;
	}
};
var SavepointRollbackLine = class extends LogEvent {
	debugLevel = LOG_LEVEL.Info;
	debugCategory = "database";
	constructor(parser, parts) {
		super(parser, parts);
		this.lineNumber = this.parseLineNumber(parts[2]);
		this.text = `${parts[3]}, line: ${this.lineNumber}`;
	}
};
var SavePointSetLine = class extends LogEvent {
	debugLevel = LOG_LEVEL.Info;
	debugCategory = "database";
	constructor(parser, parts) {
		super(parser, parts);
		this.lineNumber = this.parseLineNumber(parts[2]);
		this.text = `${parts[3]}, line: ${this.lineNumber}`;
	}
};
var TotalEmailRecipientsQueuedLine = class extends LogEvent {
	debugLevel = LOG_LEVEL.Fine;
	debugCategory = "apexProfiling";
	constructor(parser, parts) {
		super(parser, parts);
		this.text = parts[2] || "";
	}
};
var StackFrameVariableListLine = class extends LogEvent {
	debugLevel = LOG_LEVEL.Fine;
	debugCategory = "apexProfiling";
	acceptsText = true;
	constructor(parser, parts) {
		super(parser, parts);
	}
};
var StaticVariableListLine = class extends LogEvent {
	debugLevel = LOG_LEVEL.Fine;
	debugCategory = "apexProfiling";
	acceptsText = true;
	constructor(parser, parts) {
		super(parser, parts);
	}
};
var SystemModeEnterLine = class extends LogEvent {
	debugLevel = LOG_LEVEL.Info;
	debugCategory = "system";
	constructor(parser, parts) {
		super(parser, parts);
		this.text = parts[2] || "";
	}
};
var SystemModeExitLine = class extends LogEvent {
	debugLevel = LOG_LEVEL.Info;
	debugCategory = "system";
	constructor(parser, parts) {
		super(parser, parts);
		this.text = parts[2] || "";
	}
};
var ExecutionStartedLine = class extends DurationLogEvent {
	debugCategory = "apexCode";
	debugLevel = LOG_LEVEL.Error;
	namespace = "default";
	constructor(parser, parts) {
		super(parser, parts, ["EXECUTION_FINISHED"], LOG_CATEGORY.Apex, "method");
	}
};
var EnteringManagedPackageLine = class extends DurationLogEvent {
	debugCategory = "apexCode";
	debugLevel = LOG_LEVEL.Fine;
	suffix = " (managed package)";
	constructor(parser, parts) {
		super(parser, parts, [], LOG_CATEGORY.Apex, "pkg");
		const rawNs = parts[2] || "", lastDot = rawNs.lastIndexOf(".");
		this.text = this.namespace = lastDot < 0 ? rawNs : rawNs.substring(lastDot + 1);
	}
	onAfter(_parser, end) {
		if (end) this.exitStamp = end.timestamp;
	}
};
var EventSericePubBeginLine = class extends DurationLogEvent {
	debugCategory = "workflow";
	debugLevel = LOG_LEVEL.Info;
	constructor(parser, parts) {
		super(parser, parts, ["EVENT_SERVICE_PUB_END"], LOG_CATEGORY.Automation, "custom");
		this.text = parts[2] || "";
	}
};
var EventSericePubEndLine = class extends LogEvent {
	debugLevel = LOG_LEVEL.Info;
	debugCategory = "workflow";
	isExit = true;
	constructor(parser, parts) {
		super(parser, parts);
		this.text = parts[2] || "";
	}
};
var EventSericePubDetailLine = class extends LogEvent {
	debugLevel = LOG_LEVEL.Finer;
	debugCategory = "workflow";
	constructor(parser, parts) {
		super(parser, parts);
		this.text = parts[2] + " " + parts[3] + " " + parts[4];
	}
};
var EventSericeSubBeginLine = class extends DurationLogEvent {
	debugCategory = "workflow";
	debugLevel = LOG_LEVEL.Info;
	constructor(parser, parts) {
		super(parser, parts, ["EVENT_SERVICE_SUB_END"], LOG_CATEGORY.Automation, "custom");
		this.text = `${parts[2]} ${parts[3]}`;
	}
};
var EventSericeSubEndLine = class extends LogEvent {
	debugLevel = LOG_LEVEL.Info;
	debugCategory = "workflow";
	isExit = true;
	constructor(parser, parts) {
		super(parser, parts);
		this.text = `${parts[2]} ${parts[3]}`;
	}
};
var EventSericeSubDetailLine = class extends LogEvent {
	debugLevel = LOG_LEVEL.Finer;
	debugCategory = "workflow";
	constructor(parser, parts) {
		super(parser, parts);
		this.text = `${parts[2]} ${parts[3]} ${parts[4]} ${parts[6]} ${parts[6]}`;
	}
};
var FlowStartInterviewsBeginLine = class extends DurationLogEvent {
	debugCategory = "workflow";
	debugLevel = LOG_LEVEL.Info;
	constructor(parser, parts) {
		super(parser, parts, ["FLOW_START_INTERVIEWS_END"], LOG_CATEGORY.Automation, "custom");
	}
	onEnd(_end, stack) {
		const flowType = this.getFlowType(stack);
		this.suffix = ` (${flowType})`;
		this.text = this.getFlowName() || this.text;
	}
	getFlowType(stack) {
		let flowType;
		const len = stack.length - 2;
		for (let i = len; i >= 0; i--) {
			const elem = stack[i];
			if (elem instanceof CodeUnitStartedLine) {
				flowType = elem.codeUnitType === "Flow" ? "Flow" : "Process Builder";
				break;
			} else if (elem && elem.type === "FLOW_START_INTERVIEWS_BEGIN") {
				flowType = "Flow";
				break;
			}
		}
		return flowType || "";
	}
	getFlowName() {
		return this.children.find((child) => child.type === "FLOW_START_INTERVIEW_BEGIN")?.text || "";
	}
};
var FlowStartInterviewsErrorLine = class extends LogEvent {
	debugCategory = "workflow";
	debugLevel = LOG_LEVEL.Error;
	acceptsText = true;
	constructor(parser, parts) {
		super(parser, parts);
		this.text = parts.slice(2).join("|");
	}
	onAfter(_parser, _next) {
		const split = splitTrailingFields(this.text, 2);
		if (split) {
			const [message, , flowName] = split;
			this.text = `${message} - ${flowName}`;
		}
	}
};
var FlowStartInterviewBeginLine = class extends DurationLogEvent {
	debugCategory = "workflow";
	debugLevel = LOG_LEVEL.Info;
	suffix = " (flow)";
	constructor(parser, parts) {
		super(parser, parts, ["FLOW_START_INTERVIEW_END"], LOG_CATEGORY.Automation, "custom");
		this.text = parts[3] || "";
	}
};
var FlowStartInterviewLimitUsageLine = class extends LogEvent {
	debugCategory = "workflow";
	debugLevel = LOG_LEVEL.Finer;
	/** Governor-limit observation. Example: "SOQL queries: 0 out of 100". */
	limitUsage = null;
	constructor(parser, parts) {
		super(parser, parts);
		this.text = parts[2] || "";
		this.limitUsage = parseLabelledLimit(this.text);
	}
};
var FlowStartScheduledRecordsLine = class extends LogEvent {
	debugCategory = "workflow";
	debugLevel = LOG_LEVEL.Info;
	constructor(parser, parts) {
		super(parser, parts);
		this.text = `${parts[2]} : ${parts[3]}`;
	}
};
var FlowCreateInterviewErrorLine = class extends LogEvent {
	debugCategory = "workflow";
	debugLevel = LOG_LEVEL.Error;
	constructor(parser, parts) {
		super(parser, parts);
		this.text = `${parts[2]} : ${parts[3]} : ${parts[4]} : ${parts[5]}`;
	}
};
/**
* Attribute the database usage a flow element's FLOW_*_LIMIT_USAGE children report (SOQL/DML/rows
* only - CPU and heap are not counters) onto the element that ran it. The log emits no
* SOQL_EXECUTE_BEGIN or DML_BEGIN for a flow element's own database work, so the reported count is
* the only record of it.
*
* That count is the rise in the transaction's governor counter across the element, so it also
* covers any statement the element's subtree logged for itself. Only the residual - the part no
* logged statement accounts for - is attributed, which keeps the totals at or below what the log
* reports. Where a subtree statement did not consume the limit (custom metadata SOQL, for example)
* the residual understates it, because the log never says which statements were free.
*
* `self` sits on the element rather than the reporting child, unlike the statement lines, so the
* element is credited for the work it did itself.
*
* Runs after `aggregateTotals`, so each element's `total` already covers its subtree and the
* residual has to be added to every ancestor here. Elements are visited innermost first, so a
* nested element's residual is part of its parent's total before the parent is measured.
*/
function applyFlowDbResiduals(elements) {
	let i = elements.length;
	while (i--) {
		const element = elements[i];
		let reports = null;
		for (const child of element.children) {
			if (!(child instanceof FlowRunningTotalLimitUsageLine) || !child.limitUsage) continue;
			const { metric, used, delta } = child.limitUsage;
			const counter = FLOW_DB_COUNTERS.get(metric);
			if (!counter) continue;
			reports ??= /* @__PURE__ */ new Map();
			const report = reports.get(counter);
			if (report) {
				report.summed += delta;
				report.after = used;
			} else reports.set(counter, {
				summed: delta,
				before: used - delta,
				after: used
			});
		}
		if (!reports) continue;
		let residuals = null;
		for (const [counter, report] of reports) {
			const residual = Math.min(report.summed, report.after - report.before) - element[counter].total;
			if (residual <= 0) continue;
			element[counter].self += residual;
			element[counter].total += residual;
			(residuals ??= []).push([counter, residual]);
		}
		if (!residuals) continue;
		for (let ancestor = element.parent; ancestor; ancestor = ancestor.parent) for (const [counter, residual] of residuals) ancestor[counter].total += residual;
	}
}
/** Only these metrics are counters. CPU and heap are measures, so they are not attributed. */
const FLOW_DB_COUNTERS = /* @__PURE__ */ new Map([
	["soqlQueries", "soqlCount"],
	["queryRows", "soqlRowCount"],
	["soslQueries", "soslCount"],
	["dmlStatements", "dmlCount"],
	["dmlRows", "dmlRowCount"]
]);
var FlowElementBeginLine = class extends DurationLogEvent {
	debugCategory = "workflow";
	debugLevel = LOG_LEVEL.Fine;
	constructor(parser, parts) {
		super(parser, parts, ["FLOW_ELEMENT_END"], LOG_CATEGORY.Automation, "custom");
		this.text = parts[3] + " " + parts[4];
		parser.flowDbElements.push(this);
	}
};
var FlowElementDeferredLine = class extends LogEvent {
	debugCategory = "workflow";
	debugLevel = LOG_LEVEL.Fine;
	constructor(parser, parts) {
		super(parser, parts);
		this.text = parts[2] + " " + parts[3];
	}
};
var FlowElementAssignmentLine = class extends LogEvent {
	debugCategory = "workflow";
	debugLevel = LOG_LEVEL.Finer;
	acceptsText = true;
	constructor(parser, parts) {
		super(parser, parts);
		this.text = parts[3] + " " + parts[4];
	}
};
var FlowWaitEventResumingDetailLine = class extends LogEvent {
	debugCategory = "workflow";
	debugLevel = LOG_LEVEL.Finer;
	constructor(parser, parts) {
		super(parser, parts);
		this.text = `${parts[2]} : ${parts[3]} : ${parts[4]} : ${parts[5]}`;
	}
};
var FlowWaitEventWaitingDetailLine = class extends LogEvent {
	debugCategory = "workflow";
	debugLevel = LOG_LEVEL.Finer;
	constructor(parser, parts) {
		super(parser, parts);
		this.text = `${parts[2]} : ${parts[3]} : ${parts[4]} : ${parts[5]} : ${parts[6]}`;
	}
};
var FlowWaitResumingDetailLine = class extends LogEvent {
	debugCategory = "workflow";
	debugLevel = LOG_LEVEL.Finer;
	constructor(parser, parts) {
		super(parser, parts);
		this.text = `${parts[2]} : ${parts[3]} : ${parts[4]}`;
	}
};
var FlowWaitWaitingDetailLine = class extends LogEvent {
	debugCategory = "workflow";
	debugLevel = LOG_LEVEL.Finer;
	constructor(parser, parts) {
		super(parser, parts);
		this.text = `${parts[2]} : ${parts[3]} : ${parts[4]} : ${parts[5]}`;
	}
};
var FlowInterviewFinishedLine = class extends LogEvent {
	debugCategory = "workflow";
	debugLevel = LOG_LEVEL.Info;
	constructor(parser, parts) {
		super(parser, parts);
		this.text = parts[3] || "";
	}
};
var FlowInterviewResumedLine = class extends LogEvent {
	debugCategory = "workflow";
	debugLevel = LOG_LEVEL.Info;
	constructor(parser, parts) {
		super(parser, parts);
		this.text = `${parts[2]} : ${parts[3]}`;
	}
};
var FlowInterviewPausedLine = class extends LogEvent {
	debugCategory = "workflow";
	debugLevel = LOG_LEVEL.Info;
	constructor(parser, parts) {
		super(parser, parts);
		this.text = `${parts[2]} : ${parts[3]} : ${parts[4]}`;
	}
};
var FlowElementErrorLine = class extends LogEvent {
	debugCategory = "workflow";
	debugLevel = LOG_LEVEL.Error;
	acceptsText = true;
	constructor(parser, parts) {
		super(parser, parts);
		this.text = parts.slice(2).join("|");
	}
	onAfter(_parser, _next) {
		const split = splitTrailingFields(this.text, 2);
		if (split) this.text = split.filter(Boolean).join(" ");
	}
};
var FlowElementFaultLine = class extends LogEvent {
	debugCategory = "workflow";
	debugLevel = LOG_LEVEL.Warn;
	constructor(parser, parts) {
		super(parser, parts);
		this.text = `${parts[2]} : ${parts[3]} : ${parts[4]}`;
	}
};
/**
* A flow limit-usage line reporting a running total, e.g. "1 SOQL queries, total 1 out of 100".
* The enclosing flow element reads the delta from these children - see `applyFlowDbResiduals`.
*/
var FlowRunningTotalLimitUsageLine = class extends LogEvent {
	debugCategory = "workflow";
	debugLevel = LOG_LEVEL.Finer;
	/** Governor-limit observation. Example: "2 ms CPU time, total 10 out of 15000". */
	limitUsage;
	constructor(parser, parts) {
		super(parser, parts);
		this.text = parts[2] ?? "";
		this.limitUsage = parseTotalLimit(this.text);
	}
};
var FlowElementLimitUsageLine = class extends FlowRunningTotalLimitUsageLine {};
var FlowInterviewFinishedLimitUsageLine = class extends LogEvent {
	debugCategory = "workflow";
	debugLevel = LOG_LEVEL.Finer;
	/** Governor-limit observation. Example: "SOQL queries: 0 out of 100". */
	limitUsage = null;
	constructor(parser, parts) {
		super(parser, parts);
		this.text = `${parts[2]}`;
		this.limitUsage = parseLabelledLimit(this.text);
	}
};
var FlowSubflowDetailLine = class extends LogEvent {
	debugCategory = "workflow";
	debugLevel = LOG_LEVEL.Finer;
	constructor(parser, parts) {
		super(parser, parts);
		this.text = `${parts[2]} : ${parts[3]} : ${parts[4]} : ${parts[5]}`;
	}
};
var FlowActionCallDetailLine = class extends LogEvent {
	debugCategory = "workflow";
	debugLevel = LOG_LEVEL.Finer;
	constructor(parser, parts) {
		super(parser, parts);
		this.text = parts[3] + " : " + parts[4] + " : " + parts[5] + " : " + parts[6];
	}
};
var FlowAssignmentDetailLine = class extends LogEvent {
	debugCategory = "workflow";
	debugLevel = LOG_LEVEL.Finer;
	constructor(parser, parts) {
		super(parser, parts);
		this.text = parts[3] + " : " + parts[4] + " : " + parts[5];
	}
};
var FlowLoopDetailLine = class extends LogEvent {
	debugCategory = "workflow";
	debugLevel = LOG_LEVEL.Finer;
	constructor(parser, parts) {
		super(parser, parts);
		this.text = parts[3] + " : " + parts[4];
	}
};
var FlowRuleDetailLine = class extends LogEvent {
	debugCategory = "workflow";
	debugLevel = LOG_LEVEL.Finer;
	constructor(parser, parts) {
		super(parser, parts);
		this.text = parts[3] + " : " + parts[4];
	}
};
var FlowBulkElementBeginLine = class extends DurationLogEvent {
	debugCategory = "workflow";
	debugLevel = LOG_LEVEL.Fine;
	constructor(parser, parts) {
		super(parser, parts, ["FLOW_BULK_ELEMENT_END"], LOG_CATEGORY.Automation, "custom");
		this.text = `${parts[2]} - ${parts[3]}`;
		parser.flowDbElements.push(this);
	}
};
var FlowBulkElementDetailLine = class extends LogEvent {
	debugCategory = "workflow";
	debugLevel = LOG_LEVEL.Finer;
	constructor(parser, parts) {
		super(parser, parts);
		this.text = parts[2] + " : " + parts[3] + " : " + parts[4];
	}
};
var FlowBulkElementNotSupportedLine = class extends LogEvent {
	debugCategory = "workflow";
	debugLevel = LOG_LEVEL.Info;
	constructor(parser, parts) {
		super(parser, parts);
		this.text = `${parts[2]} : ${parts[3]} : ${parts[4]}`;
	}
};
var FlowBulkElementLimitUsageLine = class extends FlowRunningTotalLimitUsageLine {};
var PNInvalidAppLine = class extends LogEvent {
	debugLevel = LOG_LEVEL.Error;
	debugCategory = "apexCode";
	constructor(parser, parts) {
		super(parser, parts);
		this.text = `${parts[2]}.${parts[3]}`;
	}
};
var PNInvalidCertificateLine = class extends LogEvent {
	debugLevel = LOG_LEVEL.Error;
	debugCategory = "apexCode";
	constructor(parser, parts) {
		super(parser, parts);
		this.text = `${parts[2]}.${parts[3]}`;
	}
};
var PNInvalidNotificationLine = class extends LogEvent {
	debugLevel = LOG_LEVEL.Error;
	debugCategory = "apexCode";
	constructor(parser, parts) {
		super(parser, parts);
		this.text = `${parts[2]}.${parts[3]} : ${parts[4]} : ${parts[5]} : ${parts[6]} : ${parts[7]} : ${parts[8]}`;
	}
};
var PNNoDevicesLine = class extends LogEvent {
	debugLevel = LOG_LEVEL.Debug;
	debugCategory = "apexCode";
	constructor(parser, parts) {
		super(parser, parts);
		this.text = `${parts[2]}.${parts[3]}`;
	}
};
var PNSentLine = class extends LogEvent {
	debugLevel = LOG_LEVEL.Debug;
	debugCategory = "apexCode";
	constructor(parser, parts) {
		super(parser, parts);
		this.text = `${parts[2]}.${parts[3]} : ${parts[4]} : ${parts[5]} : ${parts[6]} : ${parts[7]}`;
	}
};
var SLAEndLine = class extends LogEvent {
	debugLevel = LOG_LEVEL.Info;
	debugCategory = "workflow";
	constructor(parser, parts) {
		super(parser, parts);
		this.text = `${parts[2]} : ${parts[3]} : ${parts[4]} : ${parts[5]} : ${parts[6]}`;
	}
};
var SLAEvalMilestoneLine = class extends LogEvent {
	debugLevel = LOG_LEVEL.Info;
	debugCategory = "workflow";
	constructor(parser, parts) {
		super(parser, parts);
		this.text = `${parts[2]}`;
	}
};
var SLAProcessCaseLine = class extends LogEvent {
	debugLevel = LOG_LEVEL.Info;
	debugCategory = "workflow";
	constructor(parser, parts) {
		super(parser, parts);
		this.text = `${parts[2]}`;
	}
};
var TestingLimitsLine = class extends LogEvent {
	debugCategory = "apexProfiling";
	debugLevel = LOG_LEVEL.Info;
	acceptsText = true;
	constructor(parser, parts) {
		super(parser, parts);
	}
};
var ValidationRuleLine = class extends LogEvent {
	debugCategory = "validation";
	debugLevel = LOG_LEVEL.Info;
	constructor(parser, parts) {
		super(parser, parts);
		this.text = parts[3] || "";
	}
};
var ValidationErrorLine = class extends LogEvent {
	debugCategory = "validation";
	debugLevel = LOG_LEVEL.Info;
	acceptsText = true;
	constructor(parser, parts) {
		super(parser, parts);
		this.text = parts[2] || "";
	}
};
var ValidationFormulaLine = class extends LogEvent {
	debugCategory = "validation";
	debugLevel = LOG_LEVEL.Info;
	acceptsText = true;
	constructor(parser, parts) {
		super(parser, parts);
		this.text = parts.slice(2).join("|");
	}
	onAfter(_parser, _next) {
		const split = splitTrailingFields(this.text, 1);
		if (split) {
			const [formula, values] = split;
			this.text = `${formula} ${values}`;
		}
	}
};
var ValidationPassLine = class extends LogEvent {
	debugCategory = "validation";
	debugLevel = LOG_LEVEL.Info;
	constructor(parser, parts) {
		super(parser, parts);
		this.text = parts[3] || "";
	}
};
var WFFlowActionErrorLine = class extends LogEvent {
	debugCategory = "workflow";
	debugLevel = LOG_LEVEL.Error;
	acceptsText = true;
	constructor(parser, parts) {
		super(parser, parts);
		let messageStart = 2;
		while (messageStart < parts.length - 1 && salesforceIdPattern.test(parts[messageStart] ?? "")) messageStart++;
		this.text = parts.slice(messageStart).join("|") || this.text;
	}
};
var WFFlowActionErrorDetailLine = class extends LogEvent {
	debugCategory = "workflow";
	debugLevel = LOG_LEVEL.Error;
	acceptsText = true;
	constructor(parser, parts) {
		super(parser, parts);
		this.text = parts.slice(2).join("|") || this.text;
	}
};
var WFFieldUpdateLine = class extends DurationLogEvent {
	debugCategory = "workflow";
	debugLevel = LOG_LEVEL.Info;
	isExit = true;
	nextLineIsExit = true;
	constructor(parser, parts) {
		super(parser, parts, ["WF_FIELD_UPDATE"], LOG_CATEGORY.Automation, "custom");
		this.text = " " + parts[2] + " " + parts[3] + " " + parts[4] + " " + parts[5] + " " + parts[6];
	}
};
var WFRuleEvalBeginLine = class extends DurationLogEvent {
	debugCategory = "workflow";
	debugLevel = LOG_LEVEL.Info;
	constructor(parser, parts) {
		super(parser, parts, ["WF_RULE_EVAL_END"], LOG_CATEGORY.Automation, "custom");
		this.text = parts[2] || "";
	}
};
var WFRuleEvalValueLine = class extends LogEvent {
	debugCategory = "workflow";
	debugLevel = LOG_LEVEL.Info;
	constructor(parser, parts) {
		super(parser, parts);
		this.text = parts[2] || "";
	}
};
var WFRuleFilterLine = class extends LogEvent {
	debugCategory = "workflow";
	debugLevel = LOG_LEVEL.Info;
	acceptsText = true;
	constructor(parser, parts) {
		super(parser, parts);
		this.text = parts[2] || "";
	}
};
var WFCriteriaBeginLine = class extends DurationLogEvent {
	debugCategory = "workflow";
	debugLevel = LOG_LEVEL.Info;
	constructor(parser, parts) {
		super(parser, parts, ["WF_CRITERIA_END", "WF_RULE_NOT_EVALUATED"], LOG_CATEGORY.Automation, "custom");
		this.text = [parts[5], parts[3]].filter(Boolean).join(" : ");
	}
};
var WFFormulaLine = class extends DurationLogEvent {
	debugCategory = "workflow";
	debugLevel = LOG_LEVEL.Info;
	acceptsText = true;
	isExit = true;
	nextLineIsExit = true;
	constructor(parser, parts) {
		super(parser, parts, ["WF_FORMULA"], LOG_CATEGORY.Automation, "custom");
		this.text = parts.slice(2).join("|");
	}
	onAfter(_parser, _next) {
		const valuesStart = this.text.indexOf("|Values:");
		if (valuesStart >= 0) {
			const formula = this.text.slice(0, valuesStart).trimEnd();
			this.text = `${formula} : ${this.text.slice(valuesStart + 1)}`;
		}
	}
};
var WFActionLine = class extends LogEvent {
	debugCategory = "workflow";
	debugLevel = LOG_LEVEL.Info;
	constructor(parser, parts) {
		super(parser, parts);
		this.text = parts[2] || "";
	}
};
var WFActionsEndLine = class extends LogEvent {
	debugCategory = "workflow";
	debugLevel = LOG_LEVEL.Info;
	constructor(parser, parts) {
		super(parser, parts);
		this.text = parts[2] || "";
	}
};
var WFActionTaskLine = class extends LogEvent {
	debugCategory = "workflow";
	debugLevel = LOG_LEVEL.Info;
	constructor(parser, parts) {
		super(parser, parts);
		this.text = `${parts[2]} : ${parts[3]} : ${parts[4]} : ${parts[5]} : ${parts[6]} : ${parts[7]}`;
	}
};
var WFApprovalLine = class extends DurationLogEvent {
	debugCategory = "workflow";
	debugLevel = LOG_LEVEL.Info;
	isExit = true;
	nextLineIsExit = true;
	constructor(parser, parts) {
		super(parser, parts, ["WF_APPROVAL"], LOG_CATEGORY.Automation, "custom");
		this.text = `${parts[2]} : ${parts[3]} : ${parts[4]}`;
	}
};
var WFApprovalRemoveLine = class extends LogEvent {
	debugCategory = "workflow";
	debugLevel = LOG_LEVEL.Info;
	constructor(parser, parts) {
		super(parser, parts);
		this.text = `${parts[2]}`;
	}
};
var WFApprovalSubmitLine = class extends DurationLogEvent {
	debugCategory = "workflow";
	debugLevel = LOG_LEVEL.Info;
	isExit = true;
	nextLineIsExit = true;
	constructor(parser, parts) {
		super(parser, parts, ["WF_APPROVAL_SUBMIT"], LOG_CATEGORY.Automation, "custom");
		this.text = `${parts[2]}`;
	}
};
var WFApprovalSubmitterLine = class extends LogEvent {
	debugCategory = "workflow";
	debugLevel = LOG_LEVEL.Info;
	constructor(parser, parts) {
		super(parser, parts);
		this.text = `${parts[2]} : ${parts[3]} : ${parts[4]}`;
	}
};
var WFAssignLine = class extends LogEvent {
	debugCategory = "workflow";
	debugLevel = LOG_LEVEL.Info;
	constructor(parser, parts) {
		super(parser, parts);
		this.text = `${parts[2]} : ${parts[3]}`;
	}
};
var WFEmailAlertLine = class extends DurationLogEvent {
	debugCategory = "workflow";
	debugLevel = LOG_LEVEL.Info;
	isExit = true;
	nextLineIsExit = true;
	constructor(parser, parts) {
		super(parser, parts, ["WF_EMAIL_ALERT"], LOG_CATEGORY.Automation, "custom");
		this.text = `${parts[2]} : ${parts[3]} : ${parts[4]}`;
	}
};
var WFEmailSentLine = class extends DurationLogEvent {
	debugCategory = "workflow";
	debugLevel = LOG_LEVEL.Info;
	isExit = true;
	nextLineIsExit = true;
	constructor(parser, parts) {
		super(parser, parts, ["WF_EMAIL_SENT"], LOG_CATEGORY.Automation, "custom");
		this.text = `${parts[2]} : ${parts[3]} : ${parts[4]}`;
	}
};
var WFEnqueueActionsLine = class extends LogEvent {
	debugCategory = "workflow";
	debugLevel = LOG_LEVEL.Info;
	constructor(parser, parts) {
		super(parser, parts);
		this.text = parts[2] || "";
	}
};
var WFEscalationActionLine = class extends LogEvent {
	debugCategory = "workflow";
	debugLevel = LOG_LEVEL.Info;
	constructor(parser, parts) {
		super(parser, parts);
		this.text = `${parts[2]} : ${parts[3]}`;
	}
};
var WFEvalEntryCriteriaLine = class extends DurationLogEvent {
	debugCategory = "workflow";
	debugLevel = LOG_LEVEL.Info;
	isExit = true;
	nextLineIsExit = true;
	constructor(parser, parts) {
		super(parser, parts, ["WF_EVAL_ENTRY_CRITERIA"], LOG_CATEGORY.Automation, "custom");
		this.text = `${parts[2]} : ${parts[3]} : ${parts[4]}`;
	}
};
var WFFlowActionDetailLine = class extends LogEvent {
	debugCategory = "workflow";
	debugLevel = LOG_LEVEL.Fine;
	constructor(parser, parts) {
		super(parser, parts);
		const optional = parts[4] ? ` : ${parts[4]} :${parts[5]}` : "";
		this.text = `${parts[2]} : ${parts[3]}` + optional;
	}
};
var WFNextApproverLine = class extends DurationLogEvent {
	debugCategory = "workflow";
	debugLevel = LOG_LEVEL.Info;
	isExit = true;
	nextLineIsExit = true;
	constructor(parser, parts) {
		super(parser, parts, ["WF_NEXT_APPROVER"], LOG_CATEGORY.Automation, "custom");
		this.text = `${parts[2]} : ${parts[3]} : ${parts[4]}`;
	}
};
var WFOutboundMsgLine = class extends LogEvent {
	debugCategory = "workflow";
	debugLevel = LOG_LEVEL.Info;
	constructor(parser, parts) {
		super(parser, parts);
		this.text = `${parts[2]} : ${parts[3]} : ${parts[4]} : ${parts[5]}`;
	}
};
var WFProcessFoundLine = class extends DurationLogEvent {
	debugCategory = "workflow";
	debugLevel = LOG_LEVEL.Info;
	isExit = true;
	nextLineIsExit = true;
	constructor(parser, parts) {
		super(parser, parts, ["WF_PROCESS_FOUND"], LOG_CATEGORY.Automation, "custom");
		this.text = `${parts[2]} : ${parts[3]}`;
	}
};
var WFProcessNode = class extends DurationLogEvent {
	debugCategory = "workflow";
	debugLevel = LOG_LEVEL.Info;
	isExit = true;
	nextLineIsExit = true;
	constructor(parser, parts) {
		super(parser, parts, ["WF_PROCESS_NODE"], LOG_CATEGORY.Automation, "custom");
		this.text = parts[2] || "";
	}
};
var WFReassignRecordLine = class extends LogEvent {
	debugCategory = "workflow";
	debugLevel = LOG_LEVEL.Info;
	constructor(parser, parts) {
		super(parser, parts);
		this.text = `${parts[2]} : ${parts[3]}`;
	}
};
var WFResponseNotifyLine = class extends LogEvent {
	debugCategory = "workflow";
	debugLevel = LOG_LEVEL.Info;
	constructor(parser, parts) {
		super(parser, parts);
		this.text = `${parts[2]} : ${parts[3]} : ${parts[4]} : ${parts[5]}`;
	}
};
var WFRuleEntryOrderLine = class extends LogEvent {
	debugCategory = "workflow";
	debugLevel = LOG_LEVEL.Info;
	constructor(parser, parts) {
		super(parser, parts);
		this.text = parts[2] || "";
	}
};
var WFRuleInvocationLine = class extends DurationLogEvent {
	debugCategory = "workflow";
	debugLevel = LOG_LEVEL.Info;
	isExit = true;
	nextLineIsExit = true;
	constructor(parser, parts) {
		super(parser, parts, ["WF_RULE_INVOCATION"], LOG_CATEGORY.Automation, "custom");
		this.text = parts[2] || "";
	}
};
var WFSoftRejectLine = class extends LogEvent {
	debugCategory = "workflow";
	debugLevel = LOG_LEVEL.Info;
	constructor(parser, parts) {
		super(parser, parts);
		this.text = parts[2] || "";
	}
};
var WFTimeTriggerLine = class extends LogEvent {
	debugCategory = "workflow";
	debugLevel = LOG_LEVEL.Info;
	constructor(parser, parts) {
		super(parser, parts);
		this.text = `${parts[2]} : ${parts[3]} : ${parts[4]} : ${parts[5]}`;
	}
};
var WFSpoolActionBeginLine = class extends LogEvent {
	debugCategory = "workflow";
	debugLevel = LOG_LEVEL.Info;
	constructor(parser, parts) {
		super(parser, parts);
		this.text = parts[2] || "";
	}
};
/**
* Splits issue text into a summary (the full first line — presentation truncation
* is the consumer's job) and a description (the remainder, e.g. a stack trace).
*/
function splitIssueText(text) {
	const newLineIndex = text.indexOf("\n");
	if (newLineIndex === -1) return {
		summary: text.trim(),
		description: ""
	};
	return {
		summary: text.slice(0, newLineIndex).trim(),
		description: text.slice(newLineIndex + 1).trim()
	};
}
var ExceptionThrownLine = class extends LogEvent {
	debugLevel = LOG_LEVEL.Info;
	debugCategory = "apexCode";
	discontinuity = true;
	acceptsText = true;
	constructor(parser, parts) {
		super(parser, parts);
		this.thrownCount.self = this.thrownCount.total = 1;
		this.lineNumber = this.parseLineNumber(parts[2]);
		this.text = parts[3] || "";
		parser.exceptions.push(this);
	}
	onAfter(parser, _next) {
		if (this.text.indexOf("System.LimitException") >= 0) {
			const { summary, description } = splitIssueText(this.text);
			parser.addLogIssue(this.timestamp, this.eventIndex, summary, description, "error");
		}
	}
};
var FatalErrorLine = class extends LogEvent {
	debugLevel = LOG_LEVEL.Error;
	debugCategory = "apexCode";
	acceptsText = true;
	discontinuity = true;
	constructor(parser, parts) {
		super(parser, parts);
		this.text = parts[2] || "";
		parser.exceptions.push(this);
	}
	onAfter(parser, _next) {
		const { summary, description } = splitIssueText(this.text);
		parser.addLogIssue(this.timestamp, this.eventIndex, summary, description, "fatal");
	}
};
var XDSDetailLine = class extends LogEvent {
	debugLevel = LOG_LEVEL.Finer;
	debugCategory = "callout";
	constructor(parser, parts) {
		super(parser, parts);
		this.text = parts[2] || "";
	}
};
var XDSResponseLine = class extends LogEvent {
	debugLevel = LOG_LEVEL.Info;
	debugCategory = "callout";
	constructor(parser, parts) {
		super(parser, parts);
		this.text = `${parts[2]} : ${parts[3]} : ${parts[4]} : ${parts[5]} : ${parts[6]}`;
	}
};
var XDSResponseDetailLine = class extends LogEvent {
	debugLevel = LOG_LEVEL.Finer;
	debugCategory = "callout";
	constructor(parser, parts) {
		super(parser, parts);
		this.text = parts[2] || "";
	}
};
var XDSResponseErrorLine = class extends LogEvent {
	debugLevel = LOG_LEVEL.Error;
	debugCategory = "callout";
	constructor(parser, parts) {
		super(parser, parts);
		this.text = parts[2] || "";
	}
};
var DuplicateDetectionBegin = class extends DurationLogEvent {
	debugCategory = "system";
	debugLevel = LOG_LEVEL.Info;
	constructor(parser, parts) {
		super(parser, parts, ["DUPLICATE_DETECTION_END"], LOG_CATEGORY.System, "custom");
	}
};
var DuplicateDetectionRule = class extends LogEvent {
	debugLevel = LOG_LEVEL.Info;
	debugCategory = "system";
	constructor(parser, parts) {
		super(parser, parts);
		this.text = `${parts[3]} - ${parts[4]}`;
	}
};
/**
* NOTE: These can be found in the org on the create new debug level page but are not found in the docs here
* https://help.salesforce.com/s/articleView?id=sf.code_setting_debug_log_levels.htm
*/
var BulkDMLEntry = class extends LogEvent {
	debugLevel = LOG_LEVEL.Info;
	debugCategory = "database";
	constructor(parser, parts) {
		super(parser, parts);
		this.text = parts[2] || "";
	}
};
/**
* DUPLICATE_DETECTION_MATCH_INVOCATION_DETAILS|EntityType:Account|ActionTaken:Allow_[Alert,Report]|DuplicateRecordIds:
*/
var DuplicateDetectionDetails = class extends LogEvent {
	debugLevel = LOG_LEVEL.Debug;
	debugCategory = "system";
	constructor(parser, parts) {
		super(parser, parts);
		this.text = parts.slice(2).join(" | ");
	}
};
/**
* DUPLICATE_DETECTION_MATCH_INVOCATION_SUMMARY|EntityType:Account|NumRecordsToBeSaved:200|NumRecordsToBeSavedWithDuplicates:0|NumDuplicateRecordsFound:0
*/
var DuplicateDetectionSummary = class extends LogEvent {
	debugLevel = LOG_LEVEL.Info;
	debugCategory = "system";
	constructor(parser, parts) {
		super(parser, parts);
		this.text = parts.slice(2).join(" | ");
	}
};
var SessionCachePutBegin = class extends DurationLogEvent {
	debugCategory = "apexCode";
	debugLevel = LOG_LEVEL.Info;
	constructor(parser, parts) {
		super(parser, parts, ["SESSION_CACHE_PUT_END"], LOG_CATEGORY.Apex, "method");
	}
};
var SessionCacheGetBegin = class extends DurationLogEvent {
	debugCategory = "apexCode";
	debugLevel = LOG_LEVEL.Info;
	constructor(parser, parts) {
		super(parser, parts, ["SESSION_CACHE_GET_END"], LOG_CATEGORY.Apex, "method");
	}
};
var SessionCacheRemoveBegin = class extends DurationLogEvent {
	debugCategory = "apexCode";
	debugLevel = LOG_LEVEL.Info;
	constructor(parser, parts) {
		super(parser, parts, ["SESSION_CACHE_REMOVE_END"], LOG_CATEGORY.Apex, "method");
	}
};
var OrgCachePutBegin = class extends DurationLogEvent {
	debugCategory = "apexCode";
	debugLevel = LOG_LEVEL.Info;
	constructor(parser, parts) {
		super(parser, parts, ["ORG_CACHE_PUT_END"], LOG_CATEGORY.Apex, "method");
	}
};
var OrgCacheGetBegin = class extends DurationLogEvent {
	debugCategory = "apexCode";
	debugLevel = LOG_LEVEL.Info;
	constructor(parser, parts) {
		super(parser, parts, ["ORG_CACHE_GET_END"], LOG_CATEGORY.Apex, "method");
	}
};
var OrgCacheRemoveBegin = class extends DurationLogEvent {
	debugCategory = "apexCode";
	debugLevel = LOG_LEVEL.Info;
	constructor(parser, parts) {
		super(parser, parts, ["ORG_CACHE_REMOVE_END"], LOG_CATEGORY.Apex, "method");
	}
};
var VFSerializeContinuationStateBegin = class extends DurationLogEvent {
	debugCategory = "visualforce";
	debugLevel = LOG_LEVEL.Info;
	constructor(parser, parts) {
		super(parser, parts, ["VF_SERIALIZE_CONTINUATION_STATE_END"], LOG_CATEGORY.Apex, "method");
	}
};
var VFDeserializeContinuationStateBegin = class extends DurationLogEvent {
	debugCategory = "visualforce";
	debugLevel = LOG_LEVEL.Info;
	constructor(parser, parts) {
		super(parser, parts, ["VF_SERIALIZE_CONTINUATION_STATE_END"], LOG_CATEGORY.Apex, "method");
	}
};
var MatchEngineBegin = class extends DurationLogEvent {
	debugCategory = "system";
	debugLevel = LOG_LEVEL.Info;
	constructor(parser, parts) {
		super(parser, parts, ["MATCH_ENGINE_END"], LOG_CATEGORY.System, "method");
	}
};
var CursorCreateBegin = class extends DurationLogEvent {
	debugCategory = "database";
	debugLevel = LOG_LEVEL.Info;
	constructor(parser, parts) {
		super(parser, parts, ["CURSOR_CREATE_END"], LOG_CATEGORY.SOQL, "method");
	}
};
var FormulaEvaluateBegin = class extends DurationLogEvent {
	debugCategory = "apexCode";
	debugLevel = LOG_LEVEL.Finer;
	constructor(parser, parts) {
		super(parser, parts, ["FORMULA_EVALUATE_END"], LOG_CATEGORY.Apex, "method");
	}
};
var RlmConfiguratorBegin = class extends DurationLogEvent {
	debugCategory = "system";
	debugLevel = LOG_LEVEL.Fine;
	constructor(parser, parts) {
		super(parser, parts, ["RLM_CONFIGURATOR_END"], LOG_CATEGORY.System, "method");
	}
};
var RlmPricingBegin = class extends DurationLogEvent {
	debugCategory = "system";
	debugLevel = LOG_LEVEL.Fine;
	constructor(parser, parts) {
		super(parser, parts, ["RLM_PRICING_END"], LOG_CATEGORY.System, "method");
	}
};
//#endregion
//#region src/LogLineMapping.ts
function getLogEventClass(eventName) {
	if (!eventName) return null;
	switch (eventName) {
		case "METHOD_ENTRY": return MethodEntryLine;
		case "METHOD_EXIT": return MethodExitLine;
		case "CONSTRUCTOR_ENTRY": return ConstructorEntryLine;
		case "CONSTRUCTOR_EXIT": return ConstructorExitLine;
	}
	const logType = lineTypeMap.get(eventName);
	if (logType) return logType;
	else if (basicLogEvents.has(eventName)) return BasicLogLine;
	else if (basicExitLogEvents.has(eventName)) return BasicExitLine;
	return null;
}
const lineTypeMap = /* @__PURE__ */ new Map([
	["BULK_DML_RETRY", BulkDMLEntry],
	["BULK_HEAP_ALLOCATE", BulkHeapAllocateLine],
	["CALLOUT_REQUEST", CalloutRequestLine],
	["CALLOUT_RESPONSE", CalloutResponseLine],
	["NAMED_CREDENTIAL_REQUEST", NamedCredentialRequestLine],
	["NAMED_CREDENTIAL_RESPONSE", NamedCredentialResponseLine],
	["NAMED_CREDENTIAL_RESPONSE_DETAIL", NamedCredentialResponseDetailLine],
	["CONSTRUCTOR_ENTRY", ConstructorEntryLine],
	["CONSTRUCTOR_EXIT", ConstructorExitLine],
	["EMAIL_QUEUE", EmailQueueLine],
	["METHOD_ENTRY", MethodEntryLine],
	["METHOD_EXIT", MethodExitLine],
	["SYSTEM_CONSTRUCTOR_ENTRY", SystemConstructorEntryLine],
	["SYSTEM_CONSTRUCTOR_EXIT", SystemConstructorExitLine],
	["SYSTEM_METHOD_ENTRY", SystemMethodEntryLine],
	["SYSTEM_METHOD_EXIT", SystemMethodExitLine],
	["CODE_UNIT_STARTED", CodeUnitStartedLine],
	["CODE_UNIT_FINISHED", CodeUnitFinishedLine],
	["VF_APEX_CALL_START", VFApexCallStartLine],
	["VF_APEX_CALL_END", VFApexCallEndLine],
	["VF_DESERIALIZE_VIEWSTATE_BEGIN", VFDeserializeViewstateBeginLine],
	["VF_EVALUATE_FORMULA_BEGIN", VFFormulaStartLine],
	["VF_EVALUATE_FORMULA_END", VFFormulaEndLine],
	["VF_SERIALIZE_CONTINUATION_STATE_BEGIN", VFSerializeContinuationStateBegin],
	["VF_DESERIALIZE_CONTINUATION_STATE_BEGIN", VFDeserializeContinuationStateBegin],
	["VF_SERIALIZE_VIEWSTATE_BEGIN", VFSeralizeViewStateStartLine],
	["VF_PAGE_MESSAGE", VFPageMessageLine],
	["DML_BEGIN", DMLBeginLine],
	["DML_END", DMLEndLine],
	["IDEAS_QUERY_EXECUTE", IdeasQueryExecuteLine],
	["SOQL_EXECUTE_BEGIN", SOQLExecuteBeginLine],
	["SOQL_EXECUTE_END", SOQLExecuteEndLine],
	["SOQL_EXECUTE_EXPLAIN", SOQLExecuteExplainLine],
	["SOSL_EXECUTE_BEGIN", SOSLExecuteBeginLine],
	["SOSL_EXECUTE_END", SOSLExecuteEndLine],
	["HEAP_ALLOCATE", HeapAllocateLine],
	["HEAP_DEALLOCATE", HeapDeallocateLine],
	["STATEMENT_EXECUTE", StatementExecuteLine],
	["VARIABLE_SCOPE_BEGIN", VariableScopeBeginLine],
	["VARIABLE_ASSIGNMENT", VariableAssignmentLine],
	["USER_INFO", UserInfoLine],
	["USER_DEBUG", UserDebugLine],
	["CUMULATIVE_LIMIT_USAGE", CumulativeLimitUsageLine],
	["CUMULATIVE_PROFILING", CumulativeProfilingLine],
	["CUMULATIVE_PROFILING_BEGIN", CumulativeProfilingBeginLine],
	["LIMIT_USAGE", LimitUsageLine],
	["LIMIT_USAGE_FOR_NS", LimitUsageForNSLine],
	["NBA_NODE_BEGIN", NBANodeBegin],
	["NBA_NODE_DETAIL", NBANodeDetail],
	["NBA_NODE_END", NBANodeEnd],
	["NBA_NODE_ERROR", NBANodeError],
	["NBA_OFFER_INVALID", NBAOfferInvalid],
	["NBA_STRATEGY_BEGIN", NBAStrategyBegin],
	["NBA_STRATEGY_END", NBAStrategyEnd],
	["NBA_STRATEGY_ERROR", NBAStrategyError],
	["POP_TRACE_FLAGS", PopTraceFlagsLine],
	["PUSH_TRACE_FLAGS", PushTraceFlagsLine],
	["QUERY_MORE_BEGIN", QueryMoreBeginLine],
	["QUERY_MORE_END", QueryMoreEndLine],
	["QUERY_MORE_ITERATIONS", QueryMoreIterationsLine],
	["TOTAL_EMAIL_RECIPIENTS_QUEUED", TotalEmailRecipientsQueuedLine],
	["SAVEPOINT_ROLLBACK", SavepointRollbackLine],
	["SAVEPOINT_SET", SavePointSetLine],
	["STACK_FRAME_VARIABLE_LIST", StackFrameVariableListLine],
	["STATIC_VARIABLE_LIST", StaticVariableListLine],
	["SYSTEM_MODE_ENTER", SystemModeEnterLine],
	["SYSTEM_MODE_EXIT", SystemModeExitLine],
	["EXECUTION_STARTED", ExecutionStartedLine],
	["ENTERING_MANAGED_PKG", EnteringManagedPackageLine],
	["EVENT_SERVICE_PUB_BEGIN", EventSericePubBeginLine],
	["EVENT_SERVICE_PUB_END", EventSericePubEndLine],
	["EVENT_SERVICE_PUB_DETAIL", EventSericePubDetailLine],
	["EVENT_SERVICE_SUB_BEGIN", EventSericeSubBeginLine],
	["EVENT_SERVICE_SUB_DETAIL", EventSericeSubDetailLine],
	["EVENT_SERVICE_SUB_END", EventSericeSubEndLine],
	["FLOW_START_INTERVIEWS_BEGIN", FlowStartInterviewsBeginLine],
	["FLOW_START_INTERVIEWS_ERROR", FlowStartInterviewsErrorLine],
	["FLOW_START_INTERVIEW_BEGIN", FlowStartInterviewBeginLine],
	["FLOW_START_INTERVIEW_LIMIT_USAGE", FlowStartInterviewLimitUsageLine],
	["FLOW_START_SCHEDULED_RECORDS", FlowStartScheduledRecordsLine],
	["FLOW_CREATE_INTERVIEW_ERROR", FlowCreateInterviewErrorLine],
	["FLOW_ELEMENT_BEGIN", FlowElementBeginLine],
	["FLOW_ELEMENT_DEFERRED", FlowElementDeferredLine],
	["FLOW_ELEMENT_ERROR", FlowElementErrorLine],
	["FLOW_ELEMENT_FAULT", FlowElementFaultLine],
	["FLOW_ELEMENT_LIMIT_USAGE", FlowElementLimitUsageLine],
	["FLOW_INTERVIEW_FINISHED_LIMIT_USAGE", FlowInterviewFinishedLimitUsageLine],
	["FLOW_SUBFLOW_DETAIL", FlowSubflowDetailLine],
	["FLOW_VALUE_ASSIGNMENT", FlowElementAssignmentLine],
	["FLOW_WAIT_EVENT_RESUMING_DETAIL", FlowWaitEventResumingDetailLine],
	["FLOW_WAIT_EVENT_WAITING_DETAIL", FlowWaitEventWaitingDetailLine],
	["FLOW_WAIT_RESUMING_DETAIL", FlowWaitResumingDetailLine],
	["FLOW_WAIT_WAITING_DETAIL", FlowWaitWaitingDetailLine],
	["FLOW_INTERVIEW_FINISHED", FlowInterviewFinishedLine],
	["FLOW_INTERVIEW_PAUSED", FlowInterviewPausedLine],
	["FLOW_INTERVIEW_RESUMED", FlowInterviewResumedLine],
	["FLOW_ACTIONCALL_DETAIL", FlowActionCallDetailLine],
	["FLOW_ASSIGNMENT_DETAIL", FlowAssignmentDetailLine],
	["FLOW_LOOP_DETAIL", FlowLoopDetailLine],
	["FLOW_RULE_DETAIL", FlowRuleDetailLine],
	["FLOW_BULK_ELEMENT_BEGIN", FlowBulkElementBeginLine],
	["FLOW_BULK_ELEMENT_DETAIL", FlowBulkElementDetailLine],
	["FLOW_BULK_ELEMENT_LIMIT_USAGE", FlowBulkElementLimitUsageLine],
	["FLOW_BULK_ELEMENT_NOT_SUPPORTED", FlowBulkElementNotSupportedLine],
	["CURSOR_CREATE_BEGIN", CursorCreateBegin],
	["FORMULA_EVALUATE_BEGIN", FormulaEvaluateBegin],
	["MATCH_ENGINE_BEGIN", MatchEngineBegin],
	["ORG_CACHE_PUT_BEGIN", OrgCachePutBegin],
	["ORG_CACHE_GET_BEGIN", OrgCacheGetBegin],
	["ORG_CACHE_REMOVE_BEGIN", OrgCacheRemoveBegin],
	["PUSH_NOTIFICATION_INVALID_APP", PNInvalidAppLine],
	["PUSH_NOTIFICATION_INVALID_CERTIFICATE", PNInvalidCertificateLine],
	["PUSH_NOTIFICATION_INVALID_NOTIFICATION", PNInvalidNotificationLine],
	["PUSH_NOTIFICATION_NO_DEVICES", PNNoDevicesLine],
	["PUSH_NOTIFICATION_SENT", PNSentLine],
	["RLM_CONFIGURATOR_BEGIN", RlmConfiguratorBegin],
	["RLM_PRICING_BEGIN", RlmPricingBegin],
	["SESSION_CACHE_PUT_BEGIN", SessionCachePutBegin],
	["SESSION_CACHE_GET_BEGIN", SessionCacheGetBegin],
	["SESSION_CACHE_REMOVE_BEGIN", SessionCacheRemoveBegin],
	["SLA_END", SLAEndLine],
	["SLA_EVAL_MILESTONE", SLAEvalMilestoneLine],
	["SLA_PROCESS_CASE", SLAProcessCaseLine],
	["TESTING_LIMITS", TestingLimitsLine],
	["VALIDATION_ERROR", ValidationErrorLine],
	["VALIDATION_FORMULA", ValidationFormulaLine],
	["VALIDATION_PASS", ValidationPassLine],
	["VALIDATION_RULE", ValidationRuleLine],
	["WF_FLOW_ACTION_ERROR", WFFlowActionErrorLine],
	["WF_FLOW_ACTION_ERROR_DETAIL", WFFlowActionErrorDetailLine],
	["WF_FIELD_UPDATE", WFFieldUpdateLine],
	["WF_RULE_EVAL_BEGIN", WFRuleEvalBeginLine],
	["WF_RULE_EVAL_VALUE", WFRuleEvalValueLine],
	["WF_RULE_FILTER", WFRuleFilterLine],
	["WF_CRITERIA_BEGIN", WFCriteriaBeginLine],
	["WF_FORMULA", WFFormulaLine],
	["WF_ACTION", WFActionLine],
	["WF_ACTIONS_END", WFActionsEndLine],
	["WF_ACTION_TASK", WFActionTaskLine],
	["WF_APPROVAL", WFApprovalLine],
	["WF_APPROVAL_REMOVE", WFApprovalRemoveLine],
	["WF_APPROVAL_SUBMIT", WFApprovalSubmitLine],
	["WF_APPROVAL_SUBMITTER", WFApprovalSubmitterLine],
	["WF_ASSIGN", WFAssignLine],
	["WF_EMAIL_ALERT", WFEmailAlertLine],
	["WF_EMAIL_SENT", WFEmailSentLine],
	["WF_ENQUEUE_ACTIONS", WFEnqueueActionsLine],
	["WF_ESCALATION_ACTION", WFEscalationActionLine],
	["WF_EVAL_ENTRY_CRITERIA", WFEvalEntryCriteriaLine],
	["WF_FLOW_ACTION_DETAIL", WFFlowActionDetailLine],
	["WF_NEXT_APPROVER", WFNextApproverLine],
	["WF_OUTBOUND_MSG", WFOutboundMsgLine],
	["WF_PROCESS_FOUND", WFProcessFoundLine],
	["WF_PROCESS_NODE", WFProcessNode],
	["WF_REASSIGN_RECORD", WFReassignRecordLine],
	["WF_RESPONSE_NOTIFY", WFResponseNotifyLine],
	["WF_RULE_ENTRY_ORDER", WFRuleEntryOrderLine],
	["WF_RULE_INVOCATION", WFRuleInvocationLine],
	["WF_SOFT_REJECT", WFSoftRejectLine],
	["WF_SPOOL_ACTION_BEGIN", WFSpoolActionBeginLine],
	["WF_TIME_TRIGGER", WFTimeTriggerLine],
	["EXCEPTION_THROWN", ExceptionThrownLine],
	["FATAL_ERROR", FatalErrorLine],
	["XDS_DETAIL", XDSDetailLine],
	["XDS_RESPONSE", XDSResponseLine],
	["XDS_RESPONSE_DETAIL", XDSResponseDetailLine],
	["XDS_RESPONSE_ERROR", XDSResponseErrorLine],
	["DUPLICATE_DETECTION_BEGIN", DuplicateDetectionBegin],
	["DUPLICATE_DETECTION_RULE_INVOCATION", DuplicateDetectionRule],
	["DUPLICATE_DETECTION_MATCH_INVOCATION_DETAILS", DuplicateDetectionDetails],
	["DUPLICATE_DETECTION_MATCH_INVOCATION_SUMMARY", DuplicateDetectionSummary]
]);
const basicLogEvents = /* @__PURE__ */ new Set([
	"ADD_SCREEN_POP_ACTION",
	"ADD_SKILL_REQUIREMENT_ACTION",
	"AE_PERSIST_VALIDATION",
	"APP_ANALYTICS_ERROR",
	"APP_ANALYTICS_FINE",
	"APP_ANALYTICS_WARN",
	"APP_CONTAINER_INITIATED",
	"ASSET_DIFF_DETAIL",
	"ASSET_DIFF_SUMMARY",
	"BULK_COUNTABLE_STATEMENT_EXECUTE",
	"CALLOUT_REQUEST_FINALIZE",
	"CALLOUT_REQUEST_PREPARE",
	"CURSOR_FETCH",
	"CURSOR_FETCH_PAGE",
	"DATA_ACCESS_EVALUATION",
	"DATAWEAVE_USER_DEBUG",
	"DUPLICATE_RULE_FILTER",
	"DUPLICATE_RULE_FILTER_INVOCATION",
	"DUPLICATE_RULE_FILTER_RESULT",
	"DUPLICATE_RULE_FILTER_VALUE",
	"END_CALL",
	"EXTERNAL_SERVICE_CALLBACK",
	"EXTERNAL_SERVICE_REQUEST",
	"EXTERNAL_SERVICE_RESPONSE",
	"FLOW_COLLECTION_PROCESSOR_DETAIL",
	"FLOW_CREATE_INTERVIEW_BEGIN",
	"FLOW_CREATE_INTERVIEW_END",
	"FLOW_SCHEDULED_PATH_QUEUED",
	"FLOW_SCREEN_DETAIL",
	"FOR_UPDATE_LOCKS_RELEASE",
	"FORMULA_BUILD",
	"FUNCTION_INVOCATION_REQUEST",
	"FUNCTION_INVOCATION_RESPONSE",
	"HEAP_DUMP",
	"INVOCABLE_ACTION_DETAIL",
	"INVOCABLE_ACTION_ERROR",
	"JSON_DIFF_DETAIL",
	"JSON_DIFF_SUMMARY",
	"MATCH_ENGINE_INVOCATION",
	"ORG_CACHE_CONTAINS",
	"ORG_CACHE_GET",
	"ORG_CACHE_GET_CAPACITY",
	"ORG_CACHE_GET_PARTITION",
	"ORG_CACHE_MEMORY_USAGE",
	"ORG_CACHE_PUT",
	"ORG_CACHE_REMOVE",
	"PLAY_PROMPT",
	"POLICY_RULE_DEFINITION_CONDITION_EVALUATION_RESPONSE",
	"POLICY_RULE_EVALUATION_REQUEST",
	"POLICY_RULE_EVALUATION_RESPONSE",
	"POLICY_RULE_EVALUATION_SKIPPED",
	"POLICY_RULE_EVALUATION_START",
	"PUSH_NOTIFICATION_INVALID_CONFIGURATION",
	"PUSH_NOTIFICATION_INVALID_PAYLOAD",
	"PUSH_NOTIFICATION_NOT_ENABLED",
	"QUERY_SQL_LOG",
	"REFERENCED_OBJECT_LIST",
	"RLM_CONFIGURATOR_DEPLOY",
	"RLM_CONFIGURATOR_STATS",
	"ROUTE_WORK_ACTION",
	"RULES_EXECUTION_DETAIL",
	"RULES_EXECUTION_SUMMARY",
	"SAVEPOINT_RELEASE",
	"SAVEPOINT_RESET",
	"SCHEDULED_FLOW_DETAIL",
	"SCRIPT_EXECUTION",
	"SESSION_CACHE_CONTAINS",
	"SESSION_CACHE_GET",
	"SESSION_CACHE_GET_CAPACITY",
	"SESSION_CACHE_GET_PARTITION",
	"SESSION_CACHE_MEMORY_USAGE",
	"SESSION_CACHE_PUT",
	"SESSION_CACHE_REMOVE",
	"SLA_CASE_MILESTONE",
	"SLA_NULL_START_DATE",
	"TEMPLATE_PROCESSING_ERROR",
	"TEMPLATED_ASSET",
	"TRANSFORMATION_SUMMARY",
	"USER_DEBUG_DEBUG",
	"USER_DEBUG_ERROR",
	"USER_DEBUG_FINE",
	"USER_DEBUG_FINER",
	"USER_DEBUG_FINEST",
	"USER_DEBUG_INFO",
	"USER_DEBUG_WARN",
	"USER_MODE_PERMSET_APPLIED",
	"VALIDATION_FAIL",
	"VARIABLE_SCOPE_END",
	"VF_APEX_CALL",
	"WAVE_APP_LIFECYCLE",
	"WF_APEX_ACTION",
	"WF_CHATTER_POST",
	"WF_ESCALATION_RULE",
	"WF_FLOW_ACTION_BEGIN",
	"WF_FLOW_ACTION_END",
	"WF_HARD_REJECT",
	"WF_KNOWLEDGE_ACTION",
	"WF_NO_PROCESS_FOUND",
	"WF_QUICK_CREATE",
	"WF_SEND_ACTION",
	"WF_TIME_TRIGGERS_BEGIN",
	"XDS_REQUEST_DETAIL"
]);
const basicExitLogEvents = /* @__PURE__ */ new Set([
	"CUMULATIVE_LIMIT_USAGE_END",
	"CUMULATIVE_PROFILING_END",
	"CURSOR_CREATE_END",
	"DUPLICATE_DETECTION_END",
	"EXECUTION_FINISHED",
	"FLOW_BULK_ELEMENT_END",
	"FLOW_ELEMENT_END",
	"FLOW_START_INTERVIEW_END",
	"FLOW_START_INTERVIEWS_END",
	"FORMULA_EVALUATE_END",
	"MATCH_ENGINE_END",
	"ORG_CACHE_GET_END",
	"ORG_CACHE_PUT_END",
	"ORG_CACHE_REMOVE_END",
	"RLM_CONFIGURATOR_END",
	"RLM_PRICING_END",
	"SESSION_CACHE_GET_END",
	"SESSION_CACHE_PUT_END",
	"SESSION_CACHE_REMOVE_END",
	"VF_DESERIALIZE_CONTINUATION_STATE_END",
	"VF_DESERIALIZE_VIEWSTATE_END",
	"VF_SERIALIZE_CONTINUATION_STATE_END",
	"VF_SERIALIZE_VIEWSTATE_END",
	"WF_CRITERIA_END",
	"WF_RULE_EVAL_END",
	"WF_RULE_NOT_EVALUATED"
]);
const names = /* @__PURE__ */ new Map();
for (const name of lineTypeMap.keys()) names.set(name, name);
for (const name of basicLogEvents) names.set(name, name);
for (const name of basicExitLogEvents) names.set(name, name);
/** Each registered event name once: an event's `type` takes its string from here, not a copy cut from its line. */
const eventNames = names;
//#endregion
//#region src/utf8.ts
const encoder = new TextEncoder();
/**
* Any size from 6 bytes up is correct, and none is measurably faster. Below 6 a chunk is one unit, a
* high surrogate there trims it to nothing, and the loop below stops advancing.
*/
const bufferBytes = 8192;
/** A UTF-16 code unit never takes more than 3 UTF-8 bytes, so a chunk this long always fits. */
const chunkUnits = Math.floor(bufferBytes / 3);
/**
* The UTF-8 byte length of a string. `String.length` counts UTF-16 code units, which under-reports
* any text holding a non-ASCII character.
*
* Encoded in passes through one small buffer, rather than measured any of the obvious ways:
* `TextEncoder.encode` copies the whole string, and counting code points by hand is around 50 times
* slower on a large log. `Buffer.byteLength` is faster still but is Node-only.
*/
function utf8ByteLength(text) {
	const buffer = new Uint8Array(bufferBytes);
	const len = text.length;
	let bytes = 0;
	for (let i = 0; i < len;) {
		let end = Math.min(i + chunkUnits, len);
		if (end < len && (text.charCodeAt(end - 1) & 64512) === 55296) end--;
		const { read, written } = encoder.encodeInto(text.slice(i, end), buffer);
		bytes += written;
		i += read;
	}
	return bytes;
}
//#endregion
//#region src/ApexLogParser.ts
const typePattern = /^[A-Z_]*$/;
const settingsPattern = /^\d+\.\d+\sAPEX_CODE,\w+;APEX_PROFILING,.+$/m;
/**
* Summaries that are a constant text describing a distinct occurrence, so every one is reported.
* Deduping them by summary would report only the first region of a log with several.
*/
const alwaysReportedSummaries = /* @__PURE__ */ new Set(["Skipped-Lines"]);
/** The truncation kind each `skip` issue describes. */
const truncationKinds = {
	"Skipped-Lines": "skipped-lines",
	"Max-Size-reached": "max-size"
};
/**
* Identity of a log issue for dedupe. Keyed on type + summary so a FATAL_ERROR and an
* EXCEPTION_THROWN with the same first line both survive.
*/
function issueKey(type, summary) {
	return type + ":" + summary;
}
function findEntryPoints(root, codeUnits) {
	const entryPoints = [];
	for (const unit of codeUnits) if (unit.parent === root || unit.parent?.type === "EXECUTION_STARTED") entryPoints.push(unit);
	return entryPoints;
}
const debugLevelKeyByToken = new Map(Object.entries({
	apexCode: "APEX_CODE",
	apexProfiling: "APEX_PROFILING",
	callout: "CALLOUT",
	dataAccess: "DATA_ACCESS",
	database: "DB",
	nba: "NBA",
	system: "SYSTEM",
	validation: "VALIDATION",
	visualforce: "VISUALFORCE",
	wave: "WAVE",
	workflow: "WORKFLOW"
}).map(([key, token]) => [token, key]));
const timestampedLinePattern = /^\d{2}:\d{2}:\d{2}\.\d+ \(\d+\)\|.*/m;
const gmtOffsetPattern = /^GMT([+-])(\d{2}):(\d{2})$/;
/**
* Minutes east of UTC, with the spelling they were read from. The header states `GMTZ` rather than
* `GMT+00:00` for UTC.
* @returns null when the header stated no offset this can read.
*/
function parseGmtOffset(text) {
	if (text === "GMTZ") return {
		minutes: 0,
		text
	};
	const match = text.match(gmtOffsetPattern);
	if (!match) return null;
	const minutes = Number.parseInt(match[2] ?? "0", 10) * 60 + Number.parseInt(match[3] ?? "0", 10);
	return {
		minutes: match[1] === "-" ? -minutes : minutes,
		text
	};
}
/**
* Reads the `USER_INFO` header line: id, user name, timezone label and offset.
* @returns null when the log states no user.
*/
function parseUserInfo(firstLine) {
	const parts = firstLine?.split("|");
	if (parts?.[1] !== "USER_INFO") return null;
	return {
		id: parts[3] || null,
		userName: parts[4] || null,
		timezone: parts[5] ? parseTimezone(parts[5], parts[6]) : null
	};
}
/**
* Field 6 is '(GMT-08:00) Pacific Standard Time (America/Los_Angeles)', or a bare, sometimes
* localised, label with either part missing. Read with string scans, not a regex, so a hostile
* field cannot make the parse slow.
*/
function parseTimezone(field, offsetField) {
	const prefixEnd = field.startsWith("(GMT") ? field.indexOf(")") : -1;
	const gmtPrefix = prefixEnd < 0 ? "" : field.slice(1, prefixEnd);
	const timezone = prefixEnd < 0 ? field : field.slice(prefixEnd + 1);
	const open = timezone.lastIndexOf("(");
	const named = open > 0 && timezone[open - 1] === " " && timezone.indexOf(")", open) === timezone.length - 1;
	const offset = parseGmtOffset(offsetField ?? "") ?? parseGmtOffset(gmtPrefix);
	return {
		text: field,
		label: (named ? timezone.slice(0, open) : timezone).trim() || null,
		name: named ? timezone.slice(open + 1, -1) : null,
		offsetMinutes: offset?.minutes ?? null,
		offsetText: offset?.text ?? null
	};
}
const logLevels = new Set(Object.values(LOG_LEVEL));
const logHeaderPattern = /^\d+\.\d+\sAPEX_CODE,\w+;APEX_PROFILING,.+\r?\n\d{2}:\d{2}:\d{2}\.\d+ \(\d+\)\|/gm;
const nanosPattern = /^\d{2}:\d{2}:\d{2}\.\d+ \((\d+)\)\|/;
/**
* Each log opens with a settings line and restarts its nanosecond counter. So a settings line whose
* next line is earlier than the last event opens a second log. A settings line alone is not enough:
* a debug message can quote one, and then the counter keeps rising.
*/
function opensNextLog(line, log, nextStart, lastEntry) {
	if (line.charCodeAt(2) === 58 || !settingsPattern.test(line)) return false;
	const nanos = log.slice(nextStart, nextStart + 40).match(nanosPattern)?.[1];
	return nanos !== void 0 && Number(nanos) < lastEntry.timestamp;
}
const skippedBytesPattern = /^\*\*\* Skipped ([\d,]+) bytes/;
const truncationMarkerPattern = /^(?:\*\*\* Skipped [\d,]+ bytes of detailed log|\*+ MAXIMUM DEBUG LOG SIZE REACHED \*+) *$/;
function isTruncationMarker(line) {
	return line.charCodeAt(0) === 42 && truncationMarkerPattern.test(line);
}
/** The platform states the dropped size on the skip line itself, with thousands separators. */
function parseSkippedBytes(line) {
	const match = line.match(skippedBytesPattern);
	return match?.[1] ? Number.parseInt(match[1].replaceAll(",", ""), 10) : void 0;
}
/**
* Takes string input of a log and returns the ApexLog class, which represents a log tree
* @param {string} logData
* @returns {ApexLog}
*/
function parse(logData) {
	return new ApexLogParser().parse(logData);
}
/**
* Stateful parsing engine. Prefer the `parse` function: it drives this class and returns an
* `ApexLog` that already carries the governor limits, log issues and namespaces accumulated here.
* The class is public because every event constructor takes one, so code that builds events needs
* it. Its fields are parser state, not API. Construct one per log if you build events against it
* yourself.
*/
var ApexLogParser = class {
	logIssues = [];
	parsingErrors = [];
	maxSizeTimestamp = null;
	/** Bytes the platform reported skipped, by the issue that reports the skip. */
	skippedBytesByIssue = /* @__PURE__ */ new Map();
	/** Events the parser could not terminate because the log stopped inside them. */
	truncatedEvents = [];
	reasons = /* @__PURE__ */ new Set();
	lastTimestamp = 0;
	discontinuity = false;
	/** Running live heap (signed allocation deltas) maintained in log order. */
	runningHeap = 0;
	namespaces = /* @__PURE__ */ new Set();
	/** Every event created during this parse, indexed by `LogEvent.eventIndex`. */
	eventsById = [];
	/** Every exception event (EXCEPTION_THROWN, FATAL_ERROR) in log order. */
	exceptions = [];
	/** Every `CODE_UNIT_STARTED` event in log order. */
	codeUnits = [];
	governorSnapshots = [];
	/**
	* Flow elements that may report their own database usage, in log order. Their usage is attributed
	* once the tree is aggregated - see {@link applyFlowDbResiduals}.
	*/
	flowDbElements = [];
	/**
	* Takes string input of a log and returns the ApexLog class, which represents a log tree
	* @param {string} debugLog
	* @returns {ApexLog}
	*/
	parse(debugLog) {
		return new this.constructor().parseLog(debugLog);
	}
	parseLog(debugLog) {
		const firstLine = debugLog.match(timestampedLinePattern);
		const eventsStart = firstLine?.index;
		const lineGenerator = this.generateLogLines(debugLog, eventsStart ?? 0);
		const apexLog = this.toLogTree(lineGenerator);
		apexLog.size = utf8ByteLength(debugLog);
		const { levels, settings } = this.parseDebugSettings(debugLog.slice(0, eventsStart));
		apexLog.debugLevels = levels;
		apexLog.debugLevelSettings = settings;
		apexLog.userInfo = parseUserInfo(firstLine?.[0]);
		apexLog.entryPoints = findEntryPoints(apexLog, this.codeUnits);
		apexLog.logIssues = this.logIssues;
		apexLog.parsingErrors = this.parsingErrors;
		apexLog.namespaces = Array.from(this.namespaces);
		apexLog.eventsById = this.eventsById;
		apexLog.exceptions = this.exceptions;
		apexLog.governorLimits = deriveGovernorLimits(this.governorSnapshots, apexLog.heapPeak);
		this.resolveIssueEndTimes(apexLog);
		apexLog.truncation = this.buildTruncation();
		apexLog.truncatedEvents = this.truncatedEvents;
		apexLog.isTruncated = apexLog.truncation.regions.length > 0;
		return apexLog;
	}
	/**
	* Assigns an `endTime` to truncation issues that can be bounded, so the timeline only
	* shades the untrusted region instead of everything up to the next marker.
	*
	* - `Skipped-Lines` (mid-log): ends at the first following *entry* event (one with
	*   `exitTypes`), because that opens a fresh, fully-present subtree where trust resumes.
	*   A detail line such as `HEAP_ALLOCATE` is ignored — it may be nested under a parent
	*   whose entry was deleted.
	* - `Max-Size-reached`: ends at the first event past the truncated region, because the
	*   next surviving line is a preserved event and is trusted (e.g. a trailing
	*   `FATAL_ERROR`). The truncated node's own remnants are collapsed onto the truncation
	*   timestamp, so we take the first later event (`timestamp > startTime`).
	* - Other issues stay point-in-time (`endTime` undefined).
	*/
	resolveIssueEndTimes(apexLog) {
		const events = this.eventsById;
		const logEndTime = apexLog.exitStamp || 0;
		for (const issue of this.logIssues) {
			const startIndex = (issue.eventIndex ?? -1) + 1;
			if (issue.summary === "Skipped-Lines") {
				let endTime = logEndTime;
				for (let i = startIndex; i < events.length; i++) {
					const event = events[i];
					if (event && event.exitTypes.length > 0) {
						endTime = event.timestamp;
						break;
					}
				}
				issue.endTime = endTime;
			} else if (issue.summary === "Max-Size-reached") {
				const startTime = issue.startTime ?? 0;
				let endTime = logEndTime;
				for (let i = startIndex; i < events.length; i++) {
					const event = events[i];
					if (event && event.timestamp > startTime) {
						endTime = event.timestamp;
						break;
					}
				}
				issue.endTime = endTime;
			}
		}
	}
	/**
	* Projects the truncation issues into regions, so a boundary is stated once. Runs after
	* `resolveIssueEndTimes`, and inherits the issue order, which is log order.
	*/
	buildTruncation() {
		const regions = this.logIssues.filter((issue) => truncationKinds[issue.summary]).map((issue) => ({
			kind: truncationKinds[issue.summary],
			startTime: issue.startTime ?? 0,
			endTime: issue.endTime,
			eventIndex: issue.eventIndex,
			skippedBytes: this.skippedBytesByIssue.get(issue)
		}));
		return {
			regions,
			totalSkippedBytes: regions.reduce((total, region) => total + (region.skippedBytes ?? 0), 0)
		};
	}
	/**
	* Applies a signed heap allocation to the running live-heap total (a negative `bytes` is a
	* deallocation) and returns the resulting live-heap level, clamped at 0. Called by the heap
	* allocation leaf events in log order; the returned value seeds their `heapPeak`, which is
	* then rolled up (by max) to the enclosing methods in {@link aggregateTotals}.
	*/
	trackHeapAllocation(bytes) {
		this.runningHeap = Math.max(0, this.runningHeap + bytes);
		return this.runningHeap;
	}
	parseLine(line, lastEntry) {
		const parts = line.split("|");
		const type = parts[1] ?? "";
		const metaCtor = getLogEventClass(type);
		if (metaCtor) {
			parts[1] = eventNames.get(type) ?? type;
			const entry = new metaCtor(this, parts);
			entry.logLine = line;
			return entry;
		}
		const hasType = !!(type && typePattern.test(type));
		if (!hasType && lastEntry?.acceptsText && !isTruncationMarker(line)) lastEntry.text += "\n" + line;
		else if (hasType) {
			const message = `Unsupported log event name: ${type}`;
			if (!this.parsingErrors.includes(message)) this.parsingErrors.push(message);
		} else if (lastEntry && line.startsWith("*** Skipped")) {
			const issue = this.addLogIssue(lastEntry.timestamp, lastEntry.eventIndex, "Skipped-Lines", `${line}. A section of the log has been skipped and the log has been truncated. Full details of this section of log can not be provided.`, "skip");
			const skippedBytes = parseSkippedBytes(line);
			if (issue && skippedBytes !== void 0) this.skippedBytesByIssue.set(issue, skippedBytes);
		} else if (lastEntry && line.indexOf("MAXIMUM DEBUG LOG SIZE REACHED") !== -1) {
			this.addLogIssue(lastEntry.timestamp, lastEntry.eventIndex, "Max-Size-reached", "The maximum log size has been reached. Part of the log has been truncated.", "skip");
			this.maxSizeTimestamp = lastEntry.timestamp;
		} else if (!hasType && settingsPattern.test(line)) {} else this.parsingErrors.push(`Invalid log line: ${line}`);
		return null;
	}
	afterParse(entry, lastEntry) {
		lastEntry?.onAfter?.(this, entry);
		if (entry.namespace) this.namespaces.add(entry.namespace);
	}
	*generateLogLines(log, startIndex) {
		const hascrlf = log.indexOf("\r\n", startIndex) > -1;
		let lastEntry = null;
		let lfIndex = log.indexOf("\n", startIndex);
		let crlfIndex = -1;
		while (startIndex < log.length) {
			const isLastLine = lfIndex === -1;
			let eolIndex = isLastLine ? log.length : lfIndex;
			if (hascrlf && !isLastLine && eolIndex > crlfIndex) {
				crlfIndex = log.indexOf("\r", eolIndex - 1);
				eolIndex = crlfIndex + 1 === lfIndex ? crlfIndex : lfIndex;
			}
			const line = log.slice(startIndex, eolIndex);
			if (line) {
				if (lastEntry && !isLastLine && opensNextLog(line, log, lfIndex + 1, lastEntry)) {
					this.reportMultipleLogs(lastEntry, log, startIndex);
					break;
				}
				const entry = this.parseLine(line, lastEntry);
				if (entry) {
					this.afterParse(entry, lastEntry);
					lastEntry = entry;
					yield entry;
				}
			}
			if (isLastLine) break;
			startIndex = lfIndex + 1;
			lfIndex = log.indexOf("\n", startIndex);
		}
		lastEntry?.onAfter?.(this);
	}
	toLogTree(lineGenerator) {
		const rootMethod = new ApexLog(this), stack = [];
		let line;
		const lineIter = new LineIterator(lineGenerator);
		while (line = lineIter.fetch()) {
			if (line.isParent) this.parseTree(line, lineIter, stack);
			line.parent = rootMethod;
			rootMethod.children.push(line);
		}
		rootMethod.setTimes();
		this.mergeManagedPackageEvents(rootMethod);
		this.aggregateTotals();
		applyFlowDbResiduals(this.flowDbElements);
		return rootMethod;
	}
	parseTree(currentLine, lineIter, stack) {
		this.lastTimestamp = currentLine.timestamp;
		currentLine.namespace ||= "default";
		if (currentLine.exitTypes.length) {
			const exitOnNextLine = currentLine.nextLineIsExit;
			let nextLine;
			let newExecution = false;
			stack.push(currentLine);
			while (nextLine = lineIter.peek()) {
				this.discontinuity ||= nextLine.discontinuity;
				if (!exitOnNextLine && !nextLine.nextLineIsExit && nextLine.isExit && !nextLine.exitTypes.length && this.endMethod(currentLine, nextLine, lineIter, stack)) {
					currentLine.onEnd?.(nextLine, stack);
					break;
				} else if (exitOnNextLine && (nextLine.nextLineIsExit || nextLine.isExit || nextLine.exitTypes.length > 0)) {
					currentLine.exitStamp = nextLine.timestamp;
					currentLine.onEnd?.(nextLine, stack);
					break;
				} else if (this.discontinuity && this.maxSizeTimestamp && nextLine.timestamp > this.maxSizeTimestamp) {
					currentLine.isTruncated = true;
					break;
				} else if (nextLine.type === "EXECUTION_STARTED") {
					newExecution = true;
					this.discontinuity = false;
					break;
				}
				lineIter.fetch();
				this.lastTimestamp = nextLine.timestamp;
				nextLine.namespace ||= currentLine.namespace || "default";
				nextLine.parent = currentLine;
				currentLine.children.push(nextLine);
				if (nextLine.isParent) this.parseTree(nextLine, lineIter, stack);
			}
			if (!nextLine || newExecution || currentLine.isTruncated) {
				const lastChild = currentLine.children.at(-1);
				currentLine.exitStamp = Math.max(this.lastTimestamp, lastChild?.exitStamp ?? lastChild?.timestamp ?? currentLine.timestamp);
				this.addLogIssue(currentLine.exitStamp, currentLine.eventIndex, "Unexpected-End", "An entry event was found without a corresponding exit event e.g a `METHOD_ENTRY` event without a `METHOD_EXIT`", "unexpected");
				if (currentLine.isTruncated) {
					this.updateLogIssue(currentLine.exitStamp, currentLine.eventIndex, "Max-Size-reached", "The maximum log size has been reached. Part of the log has been truncated.", "skip");
					this.maxSizeTimestamp = currentLine.exitStamp;
				}
				currentLine.isTruncated = true;
				this.truncatedEvents.push(currentLine);
			}
			stack.pop();
			currentLine.recalculateDurations();
		}
	}
	isMatchingEnd(startMethod, endLine) {
		return !!(endLine.type && startMethod.exitTypes.includes(endLine.type) && (endLine.lineNumber === startMethod.lineNumber || !endLine.lineNumber || !startMethod.lineNumber));
	}
	endMethod(startMethod, endLine, lineIter, stack) {
		startMethod.exitStamp = endLine.timestamp;
		if (this.isMatchingEnd(startMethod, endLine)) {
			this.discontinuity = false;
			lineIter.fetch();
			return true;
		} else if (this.discontinuity) return true;
		else {
			if (stack.some((m) => this.isMatchingEnd(m, endLine))) return true;
			this.addLogIssue(endLine.timestamp, endLine.eventIndex, "Unexpected-Exit", "An exit event was found without a corresponding entry event e.g a `METHOD_EXIT` event without a `METHOD_ENTRY`", "unexpected");
			return false;
		}
	}
	aggregateTotals() {
		const events = this.eventsById;
		let i = events.length;
		while (i--) {
			const parent = events[i];
			if (!parent?.children.length) continue;
			const children = parent.children;
			let dml = 0;
			let soql = 0;
			let sosl = 0;
			let dmlRows = 0;
			let soqlRows = 0;
			let soslRows = 0;
			let thrown = 0;
			let heapNet = 0;
			let heapGross = 0;
			let heapNetSelf = 0;
			let heapGrossSelf = 0;
			let childTime = 0;
			let heapPeak = parent.heapPeak;
			let j = children.length;
			while (j--) {
				const child = children[j];
				if (!child) continue;
				dml += child.dmlCount.total;
				soql += child.soqlCount.total;
				sosl += child.soslCount.total;
				dmlRows += child.dmlRowCount.total;
				soqlRows += child.soqlRowCount.total;
				soslRows += child.soslRowCount.total;
				childTime += child.duration.total;
				thrown += child.thrownCount.total;
				heapNet += child.heapAllocated.total;
				heapGross += child.heapGross.total;
				if (!child.isParent) {
					heapNetSelf += child.heapAllocated.self;
					heapGrossSelf += child.heapGross.self;
				}
				if (child.heapPeak > heapPeak) heapPeak = child.heapPeak;
			}
			parent.dmlCount.total += dml;
			parent.soqlCount.total += soql;
			parent.soslCount.total += sosl;
			parent.dmlRowCount.total += dmlRows;
			parent.soqlRowCount.total += soqlRows;
			parent.soslRowCount.total += soslRows;
			parent.duration.self -= childTime;
			parent.thrownCount.total += thrown;
			parent.heapAllocated.total += heapNet;
			parent.heapGross.total += heapGross;
			parent.heapAllocated.self += heapNetSelf;
			parent.heapGross.self += heapGrossSelf;
			parent.heapPeak = heapPeak;
		}
	}
	mergeManagedPackageEvents(root) {
		const stack = [root];
		while (stack.length) {
			const children = stack.pop().children;
			const len = children.length;
			let write = 0;
			let lastPkg = null;
			for (let i = 0; i < len; i++) {
				const child = children[i];
				if (!child) continue;
				const isPkg = child.type === "ENTERING_MANAGED_PKG";
				if (lastPkg && child.isParent) {
					if (isPkg && child.namespace === lastPkg.namespace) {
						lastPkg.exitStamp = child.exitStamp || child.timestamp;
						continue;
					} else if (!isPkg && child.exitStamp) {
						lastPkg.recalculateDurations();
						lastPkg = null;
					}
				}
				if (isPkg) {
					lastPkg?.recalculateDurations();
					lastPkg = child;
				}
				if (child.isParent) stack.push(child);
				children[write++] = child;
			}
			if (write < children.length) {
				children.length = write;
				lastPkg?.recalculateDurations();
			}
		}
	}
	/** Runs once, only for a text that holds more than one log, so the scan of the rest is cheap. */
	reportMultipleLogs(lastEntry, log, nextLogStart) {
		const count = Math.max(2, 1 + (log.slice(nextLogStart).match(logHeaderPattern)?.length ?? 0));
		this.addLogIssue(lastEntry.timestamp, lastEntry.eventIndex, "Multiple-Logs", `The text holds ${count} logs. Only the first log was parsed. Open each log on its own.`, "error");
	}
	/** @returns the issue as stored, or undefined when an issue with the same identity is held. */
	addLogIssue(startTime, eventIndex, summary, description, type) {
		const key = issueKey(type, summary);
		if (this.reasons.has(key) && !alwaysReportedSummaries.has(summary)) return;
		this.reasons.add(key);
		const issue = {
			startTime,
			eventIndex,
			summary,
			description,
			type
		};
		this.logIssues.push(issue);
		this.logIssues.sort((a, b) => (a.startTime || 0) - (b.startTime || 0));
		return issue;
	}
	updateLogIssue(startTime, eventIndex, summary, description, type) {
		const key = issueKey(type, summary);
		const elem = this.logIssues.findIndex((item) => issueKey(item.type, item.summary) === key);
		if (elem > -1) this.logIssues.splice(elem, 1);
		this.reasons.delete(key);
		this.addLogIssue(startTime, eventIndex, summary, description, type);
	}
	parseDebugSettings(header) {
		const levels = {};
		const settings = [];
		const line = header.match(settingsPattern)?.[0];
		if (!line) return {
			levels,
			settings
		};
		for (const entry of line.substring(line.indexOf(" ") + 1).split(";")) {
			if (!entry) continue;
			const comma = entry.indexOf(",");
			const token = comma < 0 ? entry : entry.slice(0, comma);
			const level = comma < 0 ? null : entry.slice(comma + 1) || null;
			const category = debugLevelKeyByToken.get(token) ?? null;
			settings.push({
				token,
				level,
				category
			});
			if (!category) continue;
			if (level && logLevels.has(level)) levels[category] = level;
			else this.parsingErrors.push(`Unsupported debug level: ${entry}`);
		}
		return {
			levels,
			settings
		};
	}
};
var LineIterator = class {
	next;
	lineGenerator;
	constructor(lineGenerator) {
		this.lineGenerator = lineGenerator;
		this.next = this.lineGenerator.next().value;
	}
	peek() {
		return this.next;
	}
	fetch() {
		const result = this.next;
		this.next = this.lineGenerator.next().value;
		return result;
	}
};
//#endregion
export { ALL_LIMIT_METRICS, ALL_LOG_CATEGORIES, ApexLog, ApexLogParser, CodeUnitStartedLine, DMLBeginLine, ExecutionStartedLine, HeapAllocateLine, LIMIT_METRIC, LOG_CATEGORY, LOG_LEVEL, LimitUsageLine, LogEvent, MethodEntryLine, SOQLExecuteBeginLine, SOQLExecuteExplainLine, SOSLExecuteBeginLine, parse };
