"""Focused guards for the retained OpenBao Evidence signing key."""
import copy
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest


REPO = Path(__file__).resolve().parents[2]
SPEC = importlib.util.spec_from_file_location('openbao_state', REPO / 'deployment/openbao-state.py')
openbao_state = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(openbao_state)

PUBLIC_KEY = '-----BEGIN PUBLIC KEY-----\nsynthetic-public-key\n-----END PUBLIC KEY-----'


def metadata():
    return {
        'name': 'evidence-signing',
        'type': 'ecdsa-p256',
        'derived': False,
        'deletion_allowed': False,
        'exportable': False,
        'allow_plaintext_backup': False,
        'supports_signing': True,
        'latest_version': 1,
        'auto_rotate_period': 0,
        'imported_key': False,
        'soft_deleted': False,
        'keys': {'1': {'public_key': PUBLIC_KEY}},
    }


class OpenBaoKeyGuardTests(unittest.TestCase):
    def runtime(self, root, provider_metadata, retained_key='retained-public-key\n'):
        openbao = root / 'openbao'
        output = root / 'evidence/transit-public'
        openbao.mkdir(parents=True)
        output.mkdir(parents=True)
        (openbao / 'evidence-signing-metadata.json.tmp').write_text(
            json.dumps({'data': provider_metadata}), encoding='utf-8')
        (output / 'evidence-signing.pem').write_text(retained_key, encoding='utf-8')
        (output / 'evidence-signing.jwk.json').write_text('{"kid":"retained"}\n', encoding='utf-8')
        return output

    def assert_refused_without_replacing_retained_key(self, provider_metadata):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            output = self.runtime(root, provider_metadata)
            before = {path.name: path.read_bytes() for path in output.iterdir()}
            with self.assertRaisesRegex(RuntimeError, 'single-version signing key'):
                openbao_state.record_public(root, Path('/unused/evidencectl'))
            self.assertEqual({path.name: path.read_bytes() for path in output.iterdir()}, before)

    def test_refuses_a_rotated_multi_version_key(self):
        provider = metadata()
        provider['latest_version'] = 2
        provider['keys']['2'] = {'public_key': 'rotated'}
        self.assert_refused_without_replacing_retained_key(provider)

    def test_refuses_exportable_or_plaintext_backup_key(self):
        for field in ('exportable', 'allow_plaintext_backup'):
            with self.subTest(field=field):
                provider = metadata()
                provider[field] = True
                self.assert_refused_without_replacing_retained_key(provider)

    def test_refuses_enabled_automatic_rotation(self):
        provider = metadata()
        provider['auto_rotate_period'] = 3600
        self.assert_refused_without_replacing_retained_key(provider)

    def test_accepts_the_retained_single_version_key(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            self.runtime(root, copy.deepcopy(metadata()), PUBLIC_KEY + '\n')
            openbao_state.record_public(root, Path('/unused/evidencectl'))
            self.assertFalse((root / 'openbao/evidence-signing-metadata.json.tmp').exists())


if __name__ == '__main__':
    unittest.main()
