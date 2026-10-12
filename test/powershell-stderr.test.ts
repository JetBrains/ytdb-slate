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
const withXml = (record: string) => `${start}\n#< CLIXML\n${record}\n${finish}\n`;

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
	assert.equal(classify(`#< CLIXML\n${xml}\n${start}\n${finish}`).malformed, undefined);
	assert.equal(classify(`${start}\n${finish}\n#< CLIXML\n${xml}`).malformed, undefined);
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
		assert.deepEqual(result.stages, [start]);
		assert.deepEqual(result.progress, []);
	});
}

test("PowerShell stderr rejects a second CLIXML block and enforces the byte cap", () => {
	assert.match(classify(withXml(xml) + `#< CLIXML\n${xml}\n`).malformed!, /only one CLIXML marker/);
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
	// The reader checks completeness after decoding failure metadata.
	assert.deepEqual(classify(start), { stages: [start], progress: [] });
});
