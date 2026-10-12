import assert from "node:assert/strict";
import test from "node:test";
import { classifyPowerShellStderr } from "./powershell-stderr.ts";

// Fixed first-use progress records from hosted Windows run 38228181386.
const first = '<Obj S="progress" RefId="0"><TN RefId="0"><T>System.Management.Automation.PSCustomObject</T><T>System.Object</T></TN><MS><I64 N="SourceId">1</I64><PR N="Record"><AV>Preparing modules for first use.</AV><AI>0</AI><Nil /><PI>-1</PI><PC>-1</PC><T>Completed</T><SR>-1</SR><SD> </SD></PR></MS></Obj>';
const second = '<Obj S="progress" RefId="1"><TNRef RefId="0" /><MS><I64 N="SourceId">1</I64><PR N="Record"><AV>Preparing modules for first use.</AV><AI>0</AI><Nil /><PI>-1</PI><PC>-1</PC><T>Completed</T><SR>-1</SR><SD> </SD></PR></MS></Obj>';
const opening = '<Objs Version="1.1.0.1" xmlns="http://schemas.microsoft.com/powershell/2004/04">';
const xml = opening + first + "</Objs>";
const hostedXml = opening + first + second + "</Objs>";
const start = "stage=start processMs=10 scriptMs=1";
const finish = "stage=framed processMs=20 scriptMs=2";
const expected = ["start", "framed"];
const cap = 1024 * 1024;
const classify = (stderr: string, limit = cap) => classifyPowerShellStderr(stderr, expected, limit);
const withXml = (record: string) => `#< CLIXML\n${start}\n${finish}\n${record}\n`;
// Exact stderr payload lines in the hosted log. That reader's roster has no utility stage.
const hostedStages = [
	"stage=start processMs=27212 scriptMs=207",
	"stage=services processMs=27241 scriptMs=237",
	"stage=startlayout processMs=27540 scriptMs=535",
	"stage=startapps processMs=27953 scriptMs=948",
	"stage=winrt processMs=27959 scriptMs=954",
	"stage=setting processMs=28001 scriptMs=997",
	"stage=history processMs=28038 scriptMs=1033",
	"stage=framed processMs=28856 scriptMs=1852",
];
const hostedStderr = ["#< CLIXML", ...hostedStages, hostedXml, ""].join("\n");
const hostedRoster = ["start", "services", "startlayout", "startapps", "winrt", "setting", "history", "framed"];

test("PowerShell stderr accepts the exact hosted marker, stages and two progress objects", () => {
	for (const stderr of [hostedStderr, hostedStderr.replaceAll("\n", "\r\n")]) {
		const result = classifyPowerShellStderr(stderr, hostedRoster, cap);
		assert.equal(result.malformed, undefined);
		assert.deepEqual(result.stages, hostedStages);
		assert.deepEqual(result.progress, ["CLIXML: bytes=605 preparingModulesForFirstUse=true"]);
	}
});

for (const [name, record] of [["single progress object", xml], ["hosted type-reference progress objects", hostedXml]]) {
	test(`PowerShell stderr accepts ${name} without stage credit`, () => {
		const result = classify(withXml(record!));
		assert.equal(result.malformed, undefined);
		assert.deepEqual(result.stages, [start, finish]);
		assert.deepEqual(result.progress, [`CLIXML: bytes=${Buffer.byteLength(record!, "utf8")} preparingModulesForFirstUse=true`]);
	});
}

test("PowerShell stderr accepts stages alone and CRLF progress framing", () => {
	assert.deepEqual(classify(`${start}\n${finish}\n`), { stages: [start, finish], progress: [] });
	assert.equal(classify(withXml(hostedXml).replaceAll("\n", "\r\n")).malformed, undefined);
	for (const stageLines of [[], [start], [start, finish]]) {
		const stderr = ["#< CLIXML", ...stageLines, xml].join("\n");
		const result = classify(stderr);
		assert.equal(result.malformed, undefined);
		assert.deepEqual(result.stages, stageLines);
		assert.equal(result.progress.length, 1);
	}
});

test("PowerShell stderr rejects blocks before the marker and stages outside the hosted framing", () => {
	for (const stderr of [
		`${xml}\n#< CLIXML\n${start}\n${finish}`,
		`${start}\n#< CLIXML\n${finish}\n${xml}`,
		`${start}\n${finish}\n#< CLIXML\n${xml}`,
		`#< CLIXML\n${xml}\n${start}\n${finish}`,
		withXml(xml) + "unrecognised content\n",
		withXml(xml) + "\n",
		`#< CLIXML\n${start}\n${finish}`,
		"#< CLIXML",
	]) assert.ok(classify(stderr).malformed, stderr);
});

test("PowerShell stderr rejects error records at every framing boundary", () => {
	const error = '<S S="Error">history access denied</S>';
	const lines = ["#< CLIXML", start, finish, hostedXml];
	for (let index = 0; index <= lines.length; index++) {
		const stderr = [...lines.slice(0, index), error, ...lines.slice(index)].join("\n");
		assert.ok(classify(stderr).malformed, `error at line ${index}`);
	}
	assert.ok(classify(withXml(opening + error + first + second + "</Objs>")).malformed);
	assert.ok(classify(withXml(opening + first + error + second + "</Objs>")).malformed);
	assert.ok(classify(withXml(opening + first + second + error + "</Objs>")).malformed);
});

for (const stream of ["Error", "error", "warning", "verbose", "debug", "information"]) {
	test(`PowerShell stderr rejects the ${stream} stream even beside valid progress`, () => {
		const record = `<S S="${stream}">history access denied</S>`;
		assert.match(classify(withXml(`<Objs Version="1.1.0.1">${record}</Objs>`)).malformed!, /recognised first-use progress/);
		assert.ok(classify(withXml(opening + first + record + "</Objs>")).malformed);
		assert.ok(classify(withXml(xml.replace('S="progress"', `S="${stream}"`))).malformed);
	});
}

const invalidRecords: Record<string, string> = {
	"garbage content": "<Objs>not valid XML <garbage></Objs>",
	"unclosed block": xml.replace("</Objs>", ""),
	"stage line inside the block": opening + "\n" + start + "\n" + first + "</Objs>",
	"second marker inside the block": opening + "\n#< CLIXML\n" + first + "</Objs>",
	"empty block": opening + "</Objs>",
	"unknown object": opening + '<Obj S="progress" RefId="0" />' + "</Objs>",
	"malformed object": xml.replace("</PR>", ""),
	"unknown progress activity": xml.replace("Preparing modules for first use.", "Reading toast history"),
	"encoded activity": xml.replace("Preparing", "&#80;reparing"),
	"unknown attribute": xml.replace('S="progress"', 'S="progress" X="unknown"'),
	"wrong namespace": xml.replace("powershell/2004/04", "powershell/unknown"),
	"wrong reference": hostedXml.replace('<TNRef RefId="0" />', '<TNRef RefId="1" />'),
	"nonsequential object reference": hostedXml.replace('<Obj S="progress" RefId="1">', '<Obj S="progress" RefId="3">'),
	"trailing content": xml + "garbage",
	"XML declaration": '<?xml version="1.0"?>' + xml,
};
for (const [name, record] of Object.entries(invalidRecords)) {
	test(`PowerShell stderr rejects ${name} and keeps completed stages`, () => {
		const result = classify(withXml(record));
		assert.ok(result.malformed, name);
		assert.deepEqual(result.stages, [start, finish]);
		assert.deepEqual(result.progress, []);
	});
}

test("PowerShell stderr rejects a second CLIXML block and enforces the byte cap", () => {
	for (const stderr of [
		withXml(xml) + `#< CLIXML\n${xml}\n`,
		`#< CLIXML\n#< CLIXML\n${start}\n${finish}\n${xml}`,
		`#< CLIXML\n${start}\n#< CLIXML\n${finish}\n${xml}`,
	]) assert.match(classify(stderr).malformed!, /only one CLIXML marker/);
	const bytes = Buffer.byteLength(xml, "utf8");
	assert.equal(classify(withXml(xml), bytes).malformed, undefined);
	assert.match(classify(withXml(xml), bytes - 1).malformed!, /child output cap/);
});

test("PowerShell stderr preserves stage syntax, order and timing checks", () => {
	for (const stderr of [
		`${finish}\n${start}`, `${start}\n${start}`, `${start}\n${finish}\n${finish}`,
		`${start}\nstage=framed processMs=9 scriptMs=2`, `${start}\nstage=framed processMs=20 scriptMs=0`,
		`${start}\nstage=framed processMs=20 scriptMs=21`, `${start}\nstage=framed processMs=9007199254740992 scriptMs=2`,
		`${start}\nstage=framed processMs=020 scriptMs=2`, `${start}\nstage=framed processMs=-1 scriptMs=2`,
		`${start}\n${"x".repeat(129)}`, `${start}\nunrecognised content`, `${start}\n${finish}\n\n`,
	]) assert.ok(classify(stderr).malformed, stderr);
	for (const line of [
		finish, "stage=start processMs=01 scriptMs=1", "stage=start processMs=10 scriptMs=11",
		"stage=start processMs=9007199254740992 scriptMs=1", "unrecognised content",
	]) assert.ok(classify(`#< CLIXML\n${line}\n${xml}`).malformed, line);
	assert.ok(classify(`#< CLIXML\n${start}\nstage=framed processMs=9 scriptMs=2\n${xml}`).malformed);
	assert.ok(classify(`#< CLIXML\n${start}\nstage=framed processMs=20 scriptMs=0\n${xml}`).malformed);
	// The reader checks completeness after decoding failure metadata.
	assert.deepEqual(classify(start), { stages: [start], progress: [] });
});
