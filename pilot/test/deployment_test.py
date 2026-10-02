"""Prove that lifecycle commands select only the marked 0.38 pilot."""
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest

REPO = Path(__file__).resolve().parents[2]


class DeploymentIsolationTests(unittest.TestCase):
    def test_compose_uses_separate_project_and_operator_file(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            deployment = root / 'deployment'
            deployment.mkdir()
            shutil.copy2(REPO / 'deployment/compose.sh', deployment / 'compose.sh')
            legacy = deployment / '.env'
            legacy.write_text('legacy operator configuration\n')
            binary = root / 'bin'
            binary.mkdir()
            capture = root / 'docker-arguments'
            (binary / 'docker').write_text('#!/bin/sh\nprintf "%s\\n" "$@" > "$PILOT_TEST_CAPTURE"\n')
            (binary / 'docker').chmod(0o755)
            result = subprocess.run([str(deployment / 'compose.sh'), 'ps'], capture_output=True, text=True,
                env={**os.environ, 'PATH': str(binary) + os.pathsep + os.environ['PATH'],
                    'PILOT_TEST_CAPTURE': str(capture)})
            self.assertEqual(result.returncode, 0, result.stderr)
            arguments = capture.read_text().splitlines()
            self.assertEqual(arguments[:3], ['compose', '--project-name', 'registry-openfn-pilot-038'])
            self.assertEqual(arguments[arguments.index('--env-file') + 1], str(deployment / '.env-0.38'))
            self.assertEqual(legacy.read_text(), 'legacy operator configuration\n')
            self.assertEqual((deployment / '.env-0.38').stat().st_mode & 0o777, 0o600)

    def test_start_and_reset_refuse_legacy_marker_before_any_docker_action(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            deployment = root / 'deployment'
            deployment.mkdir()
            shutil.copy2(REPO / 'deployment/pilot.sh', deployment / 'pilot.sh')
            capture = root / 'compose-was-invoked'
            (deployment / 'compose.sh').write_text('#!/bin/sh\ntouch "$PILOT_TEST_CAPTURE"\n')
            (deployment / 'compose.sh').chmod(0o755)
            runtime = root / 'pilot/agriculture/.runtime-0.38'
            runtime.mkdir(parents=True)
            marker = runtime / 'prepared.json'
            marker.write_text(json.dumps({'schema': 'synthetic-agriculture-pilot/v1', 'version': '0.27.0'}))
            legacy = root / 'pilot/agriculture/.runtime'
            legacy.mkdir()
            sentinel = legacy / 'retained-data'
            sentinel.write_text('keep')
            for arguments in [['start'], ['reset', '--confirm-delete-synthetic-data']]:
                result = subprocess.run([str(deployment / 'pilot.sh'), *arguments], capture_output=True, text=True,
                    env={**os.environ, 'PILOT_TEST_CAPTURE': str(capture)})
                self.assertNotEqual(result.returncode, 0)
                self.assertIn('not the isolated 0.38', result.stderr)
                self.assertFalse(capture.exists())
                self.assertTrue(marker.exists())
                self.assertEqual(sentinel.read_text(), 'keep')


if __name__ == '__main__':
    unittest.main()
