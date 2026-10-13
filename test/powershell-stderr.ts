import assert from "node:assert/strict";

type StderrClassification = { stages: string[]; progress: string[]; malformed?: string };
const opening = '<Objs Version="1.1.0.1" xmlns="http://schemas.microsoft.com/powershell/2004/04">';
const typeNames = '<TN RefId="0"><T>System.Management.Automation.PSCustomObject</T><T>System.Object</T></TN>';
const progressMembers = '<MS><I64 N="SourceId">1</I64><PR N="Record"><AV>Preparing modules for first use.</AV><AI>0</AI><Nil /><PI>-1</PI><PC>-1</PC><T>Completed</T><SR>-1</SR><SD> </SD></PR></MS></Obj>';

// Match only the fixed first-use progress shape. No XML parsing or entity decoding occurs.
function isStartupProgress(record: string): boolean {
	if (!record.startsWith(opening) || !record.endsWith("</Objs>")) return false;
	const end = record.length - "</Objs>".length;
	let offset = opening.length, count = 0;
	while (offset < end) {
		const object = `<Obj S="progress" RefId="${count}">` +
			(count === 0 ? typeNames : '<TNRef RefId="0" />') + progressMembers;
		if (!record.startsWith(object, offset)) return false;
		offset += object.length;
		count++;
	}
	return count > 0 && offset === end;
}

export function classifyPowerShellStderr(stderr: string, expectedStages: readonly string[], outputLimitBytes: number): StderrClassification {
	const result: StderrClassification = { stages: [], progress: [] };
	try {
		const lines = stderr.replace(/\r?\n$/, "").split(/\r?\n/);
		let previousProcessMs = 0, previousScriptMs = 0, seenMarker = false;
		for (let index = 0; index < lines.length; index++) {
			const line = lines[index]!;
			if (line === "#< CLIXML") {
				assert.ok(!seenMarker, "stderr permits only one CLIXML marker");
				assert.equal(result.stages.length, 0, "CLIXML marker must precede all stage lines");
				seenMarker = true;
				continue;
			}
			assert.equal(result.progress.length, 0, "stderr permits no content after the CLIXML block");
			if (line.startsWith("<Objs ") || line.startsWith("<Objs>")) {
				assert.ok(seenMarker, "CLIXML block requires a preceding marker");
				const xml: string[] = [];
				do {
					const part = lines[index++];
					assert.ok(part !== undefined && !part.startsWith("stage=") && part !== "#< CLIXML",
						"CLIXML stderr requires a closing Objs line before another record");
					xml.push(part);
				} while (!xml[xml.length - 1]!.endsWith("</Objs>"));
				index--;
				const record = xml.join("\n"), bytes = Buffer.byteLength(record, "utf8");
				assert.ok(bytes <= outputLimitBytes, "CLIXML stderr must remain within the child output cap");
				assert.ok(isStartupProgress(record), "CLIXML stderr requires recognised first-use progress objects only");
				result.progress.push(`CLIXML: bytes=${bytes} preparingModulesForFirstUse=true`);
				continue;
			}
			assert.ok(line.length <= 128, "stage stderr lines must remain bounded");
			const match = /^stage=([a-z]+) processMs=(0|[1-9][0-9]*) scriptMs=(0|[1-9][0-9]*)$/.exec(line);
			assert.ok(match, `malformed stage stderr: ${JSON.stringify(line).slice(0, 2000)}`);
			assert.equal(match[1], expectedStages[result.stages.length], "stage stderr must follow the exact ordered roster");
			result.stages.push(line);
			const processMs = Number(match[2]), scriptMs = Number(match[3]);
			assert.ok(Number.isSafeInteger(processMs) && Number.isSafeInteger(scriptMs) &&
				processMs >= previousProcessMs && scriptMs >= previousScriptMs && processMs >= scriptMs,
				"stage timings must be safe, ordered milliseconds");
			previousProcessMs = processMs; previousScriptMs = scriptMs;
		}
		assert.ok(!seenMarker || result.progress.length === 1, "CLIXML marker requires a progress block");
	} catch (error) {
		result.malformed = String(error).slice(0, 2000);
	}
	return result;
}
