"""Focused proofs for the Casework-to-BReg reviewer authority boundary."""
import copy
import importlib.util
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

SPEC = importlib.util.spec_from_file_location('review', Path(__file__).resolve().parents[1] / 'agriculture/review.py')
review = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(review)
REQUEST = '00000000-0000-4000-8000-000000000001'
REVIEW = '00000000-0000-4000-8000-000000000002'
TASK = '00000000-0000-4000-8000-000000000003'
DIGEST = 'sha256:' + 'a' * 64
POLICY = {'id': 'name-correction', 'version': '1', 'digest': 'sha256:' + 'b' * 64}


def snapshot():
    return {'breg': {'data': {'recordIdentifier': REQUEST, 'request': {
        'bregState': 'submitted', 'proposalVersion': 1, 'effectDigest': DIGEST,
        'review': {'submission': {'state': 'accepted', 'authority': 'casework', 'requestId': REVIEW,
            'policy': POLICY, 'submissionDigest': 'sha256:' + 'c' * 64}}, 'actions': []}}},
        'casework': {'task': {'taskId': TASK, 'requestId': REVIEW, 'revision': 1, 'state': 'open'},
            'context': {'taskId': TASK, 'requestId': REVIEW,
                'subject': {'source': 'agricultural-holdings', 'type': 'name-correction', 'id': REQUEST,
                    'version': '1', 'digest': DIGEST}, 'policy': POLICY,
                'context': {'strategy': 'source', 'bindingStatus': 'current',
                    'projection': {'display': {'name': 'Synthetic proposed name'}}}}}}


class ReviewTests(unittest.TestCase):
    def test_approval_claims_exact_review_revision_then_decides_without_registry_mutation(self):
        value = snapshot()
        claimed = {**value['casework']['task'], 'revision': 2, 'state': {'held': {'holder': {'issuer': 'local', 'subject': 'reviewer'}}}}
        with tempfile.TemporaryDirectory() as directory, patch.object(review, 'ROOT', Path(directory)), \
                patch.object(review, 'record', return_value=value['breg']), \
                patch.object(review, 'casework', side_effect=[value['casework']['context'], claimed, None]) as casework, \
                patch.object(review, 'request') as registry_mutation:
            review.approve(REQUEST, value, 'synthetic-token')
            calls = casework.call_args_list
            self.assertEqual(calls[1].args[:3], (f'/v1/review-tasks/{TASK}/claim', 'synthetic-token', 'POST'))
            self.assertEqual(calls[1].kwargs['headers']['If-Match'], '"1"')
            self.assertEqual(calls[2].args[3], {'decision': {'type': 'approve'}})
            self.assertEqual(calls[2].args[4]['If-Match'], '"2"')
            self.assertEqual((Path(directory) / 'review' / f'{REQUEST}.json').stat().st_mode & 0o777, 0o600)
            registry_mutation.assert_not_called()

    def test_changed_source_or_policy_binding_cannot_be_approved(self):
        for field in ['subject', 'policy', 'context']:
            value = snapshot()
            changed = copy.deepcopy(value['casework']['context'])
            if field == 'context':
                changed[field]['bindingStatus'] = 'binding_changed'
            else:
                changed[field]['digest'] = 'sha256:' + 'd' * 64
            with patch.object(review, 'record', return_value=value['breg']), \
                    patch.object(review, 'casework', return_value=changed) as casework:
                with self.assertRaises(RuntimeError):
                    review.approve(REQUEST, value, 'synthetic-token')
                self.assertEqual(len(casework.call_args_list), 1)
                self.assertEqual(len(casework.call_args.args), 2)

    def test_changed_proposal_refuses_before_review_authority_exchange(self):
        value = snapshot()
        changed = copy.deepcopy(value['breg'])
        changed['data']['request']['proposalVersion'] = 2
        with patch.object(review, 'record', return_value=changed), patch.object(review, 'casework') as casework:
            with self.assertRaises(RuntimeError):
                review.approve(REQUEST, value, 'synthetic-token')
            casework.assert_not_called()

    def test_application_requires_reconciled_approval_and_exact_inspected_action(self):
        value = snapshot()
        with patch.object(review, 'request') as mutation:
            with self.assertRaises(RuntimeError):
                review.apply(REQUEST, value, 'synthetic-token')
            mutation.assert_not_called()
        details = value['breg']['data']['request']
        details['review']['result'] = {'state': 'approved'}
        details['actions'] = [{'operation': 'apply_request', 'href': f'/v1/records/name-corrections/{REQUEST}/actions/apply?accessProfile=reviewer',
            'ifMatch': '"synthetic-lifecycle-etag"', 'proposalVersion': 1, 'effectDigest': DIGEST}]
        with patch.object(review, 'request') as mutation:
            review.apply(REQUEST, value, 'synthetic-token')
            self.assertEqual(mutation.call_args.args[4], {'proposalVersion': 1, 'effectDigest': DIGEST})
            self.assertEqual(mutation.call_args.args[5]['If-Match'], '"synthetic-lifecycle-etag"')
        for href in ['https://attacker.invalid/v1/records', f'/v1/records/name-corrections/{REQUEST}/actions/apply?accessProfile=other']:
            details['actions'][0]['href'] = href
            with patch.object(review, 'request') as mutation:
                with self.assertRaises(RuntimeError):
                    review.apply(REQUEST, value, 'synthetic-token')
                mutation.assert_not_called()

    def test_inspection_uses_exact_accepted_review_request(self):
        value = snapshot()
        with patch.object(review, 'record', return_value=value['breg']), \
                patch.object(review, 'casework', side_effect=[{'items': [value['casework']['task']]}, value['casework']['context']]):
            self.assertEqual(review.inspect(REQUEST, 'synthetic-token'), value)

    def test_inspection_waits_for_registry_reconciliation_after_casework_decision(self):
        value = snapshot()
        reconciled = copy.deepcopy(value['breg'])
        reconciled['data']['request']['review']['result'] = {'state': 'approved'}
        decided = {**value['casework']['task'], 'state': 'decided'}
        with patch.object(review, 'record', side_effect=[value['breg'], reconciled]), \
                patch.object(review, 'casework', return_value={'items': [decided]}) as casework, \
                patch.object(review.time, 'sleep'):
            self.assertEqual(review.inspect(REQUEST, 'synthetic-token'), {'breg': reconciled})
            self.assertEqual(len(casework.call_args_list), 1)


if __name__ == '__main__':
    unittest.main()
