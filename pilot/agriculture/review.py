#!/usr/bin/env python3
"""Inspect a synthetic correction, approve its Casework review, then explicitly apply."""
import argparse
import json
import os
from pathlib import Path
import time
import urllib.request
import urllib.error
import urllib.parse
import uuid

ROOT = Path('/config/breg')
RUNTIME = Path('/workspace/pilot/agriculture/.runtime-0.38')
BREG = 'http://127.0.0.1:8090'
CASEWORK = 'http://127.0.0.1:8092'
CASEWORK_HEADERS = {'Registry-Casework-Profile': 'reviewer', 'Registry-Source-Profile': 'reviewer'}


def token():
    from issuer import token as issue_token
    return issue_token(RUNTIME, 'reviewer')


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def request(origin, path, bearer, method='GET', body=None, headers=None):
    if origin not in [BREG, CASEWORK] or not path.startswith('/v1/') or path.startswith('//'):
        raise RuntimeError('Unexpected service location; credential was not forwarded')
    req = urllib.request.Request(origin + path, method=method,
        data=None if body is None else json.dumps(body).encode(),
        headers={'Authorization': 'Bearer ' + bearer, 'Accept': 'application/json',
            **({'Content-Type': 'application/json'} if body is not None else {}), **(headers or {})})
    try:
        with urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect()).open(req, timeout=10) as response:
            content = response.read()
            return json.loads(content) if content else None
    except urllib.error.HTTPError as error:
        raise RuntimeError(f'Service refused the reviewed action (HTTP {error.code})') from None
    except (OSError, urllib.error.URLError, ValueError):
        raise RuntimeError('Reviewed service exchange did not complete') from None


def record(request_id, bearer):
    return request(BREG, f'/v1/records/name-corrections/{request_id}?accessProfile=reviewer', bearer)


def casework(path, bearer, method='GET', body=None, headers=None):
    return request(CASEWORK, path, bearer, method, body, {**CASEWORK_HEADERS, **(headers or {})})


def save(path, value):
    path.parent.mkdir(exist_ok=True, mode=0o700)
    temporary = path.with_suffix('.tmp')
    fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, 'w') as handle:
        json.dump(value, handle, indent=2)
        handle.write('\n')
    temporary.chmod(0o600)
    temporary.replace(path)
    path.chmod(0o600)


def frozen(value):
    details = value['data']['request']
    return details['proposalVersion'], details['effectDigest'], details.get('review', {}).get('submission')


def validate_context(request_id, value, context):
    details = value['data']['request']
    submission = details['review']['submission']
    subject = context.get('subject', {})
    if (submission.get('state') != 'accepted' or submission.get('authority') != 'casework'
            or context.get('requestId') != submission.get('requestId')
            or subject != {'source': 'agricultural-holdings', 'type': 'name-correction', 'id': request_id,
                'version': str(details['proposalVersion']), 'digest': details['effectDigest']}
            or context.get('policy') != submission.get('policy')
            or context.get('context', {}).get('strategy') != 'source'
            or context['context'].get('bindingStatus') != 'current'):
        raise RuntimeError('Casework context does not match the inspected current proposal')


def task_for(review_id, bearer):
    cursor = None
    seen = set()
    for _ in range(10):
        query = {'queue': 'corrections', 'limit': 100}
        if cursor:
            query['cursor'] = str(uuid.UUID(cursor))
        page = casework('/v1/review-tasks?' + urllib.parse.urlencode(query), bearer)
        matches = [item for item in page['items'] if item['requestId'] == review_id]
        if len(matches) > 1:
            raise RuntimeError('Review task selection is ambiguous')
        if matches:
            return matches[0]
        cursor = page.get('nextCursor')
        if not cursor:
            return None
        if cursor in seen:
            raise RuntimeError('Casework repeated its task cursor')
        seen.add(cursor)
    raise RuntimeError('Review task selection exceeded its bounded page budget')


def inspect(request_id, bearer, timeout=90):
    end = time.monotonic() + timeout
    while True:
        value = record(request_id, bearer)
        details = value['data']['request']
        result = details.get('review', {}).get('result', {}).get('state')
        if details['bregState'] == 'applied' or result in ['approved', 'rejected', 'cancelled']:
            return {'breg': value}
        submission = details.get('review', {}).get('submission', {})
        if submission.get('state') == 'accepted':
            task = task_for(submission['requestId'], bearer)
            if task and task['state'] != 'decided':
                task_id = str(uuid.UUID(task['taskId']))
                context = casework(f'/v1/review-tasks/{task_id}/context', bearer)
                validate_context(request_id, value, context)
                return {'breg': value, 'casework': {'task': task, 'context': context}}
        if time.monotonic() >= end:
            raise RuntimeError('The submitted correction has no available Casework review task')
        time.sleep(1)


def approve(request_id, snapshot, bearer):
    value = record(request_id, bearer)
    if frozen(value) != frozen(snapshot['breg']):
        raise RuntimeError('The proposal changed after inspection; inspect current state first')
    if value['data']['request'].get('review', {}).get('result', {}).get('state') == 'approved':
        return
    reviewed = snapshot.get('casework')
    if not reviewed:
        raise RuntimeError('Inspect this Casework review before approving')
    task = reviewed['task']
    task_id = str(uuid.UUID(task['taskId']))
    path = f'/v1/review-tasks/{task_id}'
    context = casework(path + '/context', bearer)
    validate_context(request_id, value, context)
    if context != reviewed['context']:
        raise RuntimeError('The review context changed after inspection; inspect current state first')
    if task['state'] == 'open':
        claimed = casework(path + '/claim', bearer, 'POST', headers={
            'If-Match': f'"{task["revision"]}"', 'Idempotency-Key': f'reviewer:{task_id}:claim:{task["revision"]}'})
        task = claimed
        snapshot['casework']['task'] = task
        save(ROOT / 'review' / f'{request_id}.json', snapshot)
    casework(path + '/decisions', bearer, 'POST', {'decision': {'type': 'approve'}}, {
        'If-Match': f'"{task["revision"]}"', 'Idempotency-Key': f'reviewer:{task_id}:approve:{task["revision"]}'})


def apply(request_id, snapshot, bearer):
    value = snapshot['breg']
    details = value['data']['request']
    if details['bregState'] == 'applied':
        return
    if details.get('review', {}).get('result', {}).get('state') != 'approved':
        raise RuntimeError('BReg has not reconciled the approved review; inspect current state first')
    actions = [action for action in details['actions'] if action['operation'] == 'apply_request']
    if len(actions) != 1:
        raise RuntimeError('The inspected snapshot has no unique permitted apply action')
    action = actions[0]
    parsed = urllib.parse.urlsplit(action['href'])
    expected = f'/v1/records/name-corrections/{request_id}/actions/apply'
    if (parsed.scheme or parsed.netloc or parsed.fragment or parsed.path != expected
            or urllib.parse.parse_qs(parsed.query) != {'accessProfile': ['reviewer']}
            or action.get('method', 'POST') != 'POST'):
        raise RuntimeError('Unexpected action location; credential was not forwarded')
    body = {key: action[key] for key in ['proposalVersion', 'effectDigest']}
    request(BREG, action['href'], bearer, 'POST', body, {
        'If-Match': action['ifMatch'],
        'Idempotency-Key': f'reviewer:{request_id}:apply:{body["proposalVersion"]}:{body["effectDigest"]}'})


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=['inspect', 'approve', 'apply'])
    parser.add_argument('request_id', type=uuid.UUID)
    args = parser.parse_args()
    os.umask(0o077)
    request_id = str(args.request_id)
    path = ROOT / 'review' / f'{request_id}.json'
    bearer = token()
    if args.action == 'inspect':
        snapshot = inspect(request_id, bearer)
        save(path, snapshot)
        print(json.dumps(snapshot, indent=2))
        print('Review the proposal above. Casework approval and BReg application are separate commands.')
        return
    if not path.exists():
        raise RuntimeError('Inspect this correction first; no reviewed snapshot exists')
    snapshot = json.loads(path.read_text())
    if snapshot['breg']['data']['recordIdentifier'] != request_id:
        raise RuntimeError('The saved snapshot belongs to another correction')
    if args.action == 'approve':
        approve(request_id, snapshot, bearer)
        print('Casework approval recorded; the farm is unchanged. Wait for BReg reconciliation and inspect again before applying.')
    else:
        apply(request_id, snapshot, bearer)
        print('The reviewed correction was applied.')


if __name__ == '__main__':
    main()
