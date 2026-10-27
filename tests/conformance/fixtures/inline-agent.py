#!/usr/bin/env python3
"""Deterministic, explicitly labelled CLI fixture. No model or network call is made.
It exercises the real bridge, CAD engine, checks and proposal flow on disposable projects.
"""
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import time

claude = '--output-format' in sys.argv
if '--version' in sys.argv:
    # Invoked through a link named claude, it answers as the Claude Code build the host checked.
    print('2.1.287 (Claude Code)' if Path(sys.argv[0]).name == 'claude' else 'codex-cli 0.156.1')
    sys.exit(0)
prompt = sys.stdin.read()
helper = os.environ.get('BUREAU_INLINE_HELPER', str(Path(__file__).resolve().parents[3] / 'native/bureau-bridge/target/release/bureau'))

def call(op, payload):
    result = subprocess.run([helper, 'call', op, '--input', '-'], input=json.dumps(payload), capture_output=True, text=True)
    if result.returncode:
        raise RuntimeError(op + ': ' + result.stderr)
    return json.loads(result.stdout)

def emit(value):
    print(json.dumps(value), flush=True)

def after(flag, default=None):
    return sys.argv[sys.argv.index(flag) + 1] if flag in sys.argv else default

def finish(text):
    if claude:
        emit({'type': 'assistant', 'message': {'content': [{'type': 'text', 'text': text}]}})
        emit({'type': 'result', 'subtype': 'success', 'is_error': False, 'result': text})
    else:
        emit({'type': 'item.completed', 'item': {'id': 'fixture-message', 'type': 'agent_message', 'text': text}})
        emit({'type': 'turn.completed'})

def partial(text, full=False):
    if claude:
        if full:
            emit({'type': 'assistant', 'message': {'content': [{'type': 'text', 'text': text}]}})
        else:
            emit({'type': 'stream_event', 'event': {'type': 'content_block_delta', 'delta': {'type': 'text_delta', 'text': text}}})
    else:
        emit({'type': 'item.completed' if full else 'item.updated', 'item': {'id': 'fixture-message', 'type': 'agent_message', 'text': text}})

if claude:
    # What Claude Code's init event reports: the conversation it was given or resumed, and the model.
    emit({'type': 'system', 'subtype': 'init', 'session_id': after('--resume', after('--session-id', '')),
          'model': after('--model', 'fixture-model'), 'mcp_servers': [{'name': 'bureau', 'status': 'connected'}]})

GATE_BRIEF = 'Bureau ran work_status after the previous reply'
if 'UNFINISHED_FIXTURE' in prompt or GATE_BRIEF in prompt:
    try:
        if '--resume' in sys.argv and ('Prior exact input' in prompt or 'User: UNFINISHED_FIXTURE' in prompt):
            raise RuntimeError('A resumed conversation was sent its history again')
        if GATE_BRIEF in prompt:
            # Continue from what the host recorded: fill every empty fixture note.
            listed = call('artifact.list', {'type': 'note'})
            for entry in listed.get('artifacts', []):
                artifact = entry.get('artifact', entry)
                if artifact.get('title') == 'Fixture notes':
                    call('artifact.update_draft', {'artifactId': artifact['id'], 'payload': {'markdown': 'Filled by the deterministic fixture.'},
                                                   'rationale': 'Deterministic continuation fixture'})
            finish('**Deterministic fixture.** The notes are filled; work_status decides whether anything is left.')
        else:
            # Leave work the agent can finish from the record: an empty draft.
            call('artifact.create_draft', {'type': 'note', 'title': 'Fixture notes', 'payload': {'markdown': ''},
                                           'rationale': 'Deterministic unfinished-work fixture'})
            finish('**Deterministic fixture.** I drafted the notes and stopped before writing them.')
    except Exception as error:
        emit({'type': 'result', 'subtype': 'error_during_execution', 'is_error': True, 'result': str(error)} if claude else {'type': 'turn.failed', 'error': {'message': str(error)}})
        sys.exit(1)
    sys.exit(0)

try:
    chunks = ['**Deterministic fixture.** No model was run. ', 'I am using the exact submitted quantities and real local tools. ', 'Results below name what was rendered, checked, and left for human review.']
    if claude:
        emit({'type': 'stream_event', 'event': {'type': 'message_start'}})
    for i, chunk in enumerate(chunks):
        partial(chunk if claude else ''.join(chunks[:i+1]))
        time.sleep(1.4)
        if 'PARTIAL_EOF' in prompt and i == 0:
            sys.exit(0)
        if 'CANCEL_FIXTURE' in prompt and i == 0:
            time.sleep(60)
    full = ''.join(chunks)
    denied = subprocess.run([helper, 'call', 'proposal.approve', '--input', '-'], input=json.dumps({'proposalId': '00000000-0000-4000-8000-000000000001'}), capture_output=True, text=True)
    if denied.returncode == 0 or 'CAPABILITY_DENIED' not in denied.stderr:
        raise RuntimeError('Human approval was not denied')
    match = re.findall(r'Exact user-approved input attachment .*?: (\{[^\n]+\})\n', prompt)
    if match:
        exact = json.loads(match[-1])
        if exact.get('intent') == 'render' and exact.get('artifactId'):
            aid, rid = exact['artifactId'], exact['revisionId']
            source = call('cad.read_source', {'artifactId': aid, 'revisionId': rid})
            params = source.get('recordedParams', {}).copy()
            for field in exact['fields']:
                if field['unknown']:
                    raise RuntimeError('Unknown dimension needs clarification: ' + field['name'])
                value = float(field['text'])
                unit = field['unit']
                factor = {'mm': 1, 'cm': 10, 'in': 25.4, 'deg': 1, 'count': 1, '': 1}.get(unit)
                if factor is None:
                    raise RuntimeError('Fixture does not convert ' + unit)
                params[field['name']] = value * factor
            rendered = call('cad.write_source', {'artifactId': aid, 'expectedRevisionId': rid, 'source': source['source'], 'params': params, 'rationale': 'Deterministic inline fixture: exact user-approved dimensions'})
            revision = rendered['revisionId']
            call('ui.open_artifact', {'artifactId': aid})
            call('chat.present', {'part': {'kind': 'artifact', 'artifactId': aid, 'revisionId': revision}})
            # Scope comes from requested dimensions and the known source fixture, never measured output.
            defaults = {name: float(v) for name, v in re.findall(r'(?m)^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*([0-9.]+)\s*;', source['source'])}
            defaults.update(params)
            if {'tray_width', 'tray_depth', 'tray_thick', 'wall_h'} <= defaults.keys():
                expect = {'size': [defaults['tray_width'], defaults['tray_depth'], defaults['tray_thick'] + defaults['wall_h']], 'bodies': 1}
                checked = call('cad.check', {'artifactId': aid, 'revisionId': revision, 'expect': expect, 'autoCommit': True})
                full += '\n\nLocal engine check returned: ' + str(checked.get('verificationStatus', 'status unspecified')) + '. Scope: requested outer dimensions and one body; holes and manufacturing suitability were not checked.'
            baseline = call('artifact.read', {'artifactId': aid, 'detail': 'full'})['view']['artifact'].get('selectedRevisionId')
            proposal = call('proposal.submit', {'reason': 'Review exact inline dimensions (deterministic fixture)', 'changes': [{'artifactId': aid, 'baseRevisionId': baseline, 'newRevisionId': revision, 'kind': 'baseline_update' if baseline else 'new_artifact'}]})
            proposal_id = proposal.get('proposal', proposal).get('id') or proposal.get('proposalId')
            call('ui.request_review', {'proposalId': proposal_id})
    else:
        note = call('artifact.create_draft', {'type': 'note', 'title': 'Deterministic inline record', 'payload': {'markdown': 'This draft was created through the real local CLI bridge by a deterministic fixture. No model produced it.'}, 'rationale': 'Transport and safe rich UI validation'})
        aid = note['artifact']['id']
        call('ui.open_artifact', {'artifactId': aid})
        call('chat.present', {'part': {'kind': 'artifact', 'artifactId': aid}})
    call('chat.present', {'part': {'kind': 'chart', 'title': 'A dimension scenario', 'xLabel': 'Width', 'xUnit': 'mm', 'yLabel': 'Illustrative volume', 'yUnit': 'cm³', 'source': 'Deterministic fixture example, not an engine result', 'provenance': 'illustrative', 'points': [{'x': 50, 'y': 18}, {'x': 60, 'y': 24}, {'x': 70, 'y': 33}, {'x': 80, 'y': 45}]}})
    call('chat.present', {'part': {'kind': 'form', 'title': 'What should the next check cover?', 'fields': [{'name': 'payload', 'label': 'Payload mass', 'unit': 'kg', 'value': 0.5}, {'name': 'shock', 'label': 'Peak shock', 'unit': 'g', 'value': None, 'reason': 'No measurement has been supplied'}]}})
    call('chat.present', {'part': {'kind': 'choices', 'title': 'Continue from this result', 'options': [{'label': 'Inspect the test scope', 'prompt': 'Explain the recorded test scope and what remains unverified.'}, {'label': 'Consider a lighter version', 'prompt': 'Prepare a lighter design option. Keep dimensions and evidence explicit.'}]}})
    partial(full, full=True)
    if claude:
        emit({'type': 'result', 'subtype': 'success', 'is_error': False, 'result': full})
    else:
        emit({'type': 'turn.completed'})
except Exception as error:
    emit({'type': 'result', 'subtype': 'error_during_execution', 'is_error': True, 'result': str(error)} if claude else {'type': 'turn.failed', 'error': {'message': str(error)}})
    sys.exit(1)
