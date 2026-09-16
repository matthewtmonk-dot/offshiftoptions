"""Run with python3 on Linux/WSL; all curl calls use a local fake, never the network."""
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest


ROOT = Path(__file__).resolve().parents[2]
SECRET = "test-cron-sentinel-123456789"
PASSWORD = "test-private-value"


def workflow_script(name):
    lines = (ROOT / ".github/workflows" / name).read_text().splitlines()
    start = lines.index("        run: |") + 1
    return "\n".join(line[10:] if line.startswith("          ") else line for line in lines[start:]) + "\n"


FAKE_CURL = r'''#!/usr/bin/env python3
import json, os, pathlib, sys
args = sys.argv[1:]
assert args[args.index('--connect-timeout') + 1] == '20'
assert args[args.index('--max-time') + 1] == os.environ['EXPECTED_TOTAL_TIMEOUT']
assert args[args.index('-H') + 1] == 'Authorization: Bearer ' + os.environ['CRON_SECRET']
assert '--retry' not in args and '-L' not in args and '--location' not in args
with open(os.environ['CALL_LOG'], 'a') as log:
    log.write('called\n')
body = os.environ['MOCK_BODY']
if '-o' in args:
    pathlib.Path(args[args.index('-o') + 1]).write_text(body)
else:
    print(body)
if '-w' in args:
    print(os.environ['MOCK_STATUS'], end='')
if os.environ.get('MOCK_STDERR'):
    print(os.environ['MOCK_STDERR'], file=sys.stderr)
sys.exit(int(os.environ['MOCK_EXIT']))
'''


class CronWorkflowTests(unittest.TestCase):
    def run_workflow(self, status="200", exit_code=0, body="{}", workflow="technical-preparation-cron.yml", stderr=""):
        script = workflow_script(workflow)
        syntax = subprocess.run(["bash", "-n"], input=script, text=True, capture_output=True)
        self.assertEqual(syntax.returncode, 0, syntax.stderr)
        with tempfile.TemporaryDirectory(prefix="oso-cron-test-") as directory:
            fake = Path(directory) / "curl"
            fake.write_text(FAKE_CURL)
            fake.chmod(0o700)
            log = Path(directory) / "calls"
            env = {
                "PATH": directory + os.pathsep + os.environ["PATH"],
                "CRON_SECRET": SECRET,
                "TEST_PASSWORD": PASSWORD,
                "CALL_LOG": str(log),
                "MOCK_STATUS": status,
                "MOCK_EXIT": str(exit_code),
                "MOCK_BODY": body,
                "MOCK_STDERR": stderr,
                "EXPECTED_TOTAL_TIMEOUT": "300" if workflow.startswith("alpha") else "90",
            }
            result = subprocess.run(["bash", "-s"], input=script, env=env, text=True, capture_output=True, timeout=15)
            calls = len(log.read_text().splitlines()) if log.exists() else 0
        self.assertNotIn(SECRET, result.stdout + result.stderr)
        self.assertNotIn(PASSWORD, result.stdout + result.stderr)
        return result, calls

    def test_200_continues_at_most_twice(self):
        result, calls = self.run_workflow(body=json.dumps({"status": "OK", "generationStatus": "IN_PROGRESS", "remainingEligibleCount": 2}))
        self.assertEqual((result.returncode, calls), (0, 2))
        self.assertEqual(result.stdout.count("HTTP_STATUS=200"), 2)

    def test_200_terminal_stops(self):
        result, calls = self.run_workflow(body='{"status":"OUTSIDE_WINDOW"}')
        self.assertEqual((result.returncode, calls), (0, 1))

    def test_all_rejected_http_statuses_stop_before_cycle_two(self):
        for status in ("301", "302", "307", "401", "403", "500"):
            with self.subTest(status=status):
                result, calls = self.run_workflow(status=status, exit_code=22 if int(status) >= 400 else 0,
                    body='{"status":"OK","generationStatus":"IN_PROGRESS","remainingEligibleCount":2}')
                self.assertEqual((result.returncode, calls), (22, 1))
                self.assertIn("HTTP_STATUS=" + status, result.stdout)
                self.assertIn("CURL_EXIT=" + ("22" if int(status) >= 400 else "0"), result.stdout)
                self.assertIn("RESPONSE_BODY_END", result.stdout)

    def test_network_failures_keep_exit_and_stop(self):
        for code in (6, 7, 28):
            with self.subTest(code=code):
                result, calls = self.run_workflow(status="000", exit_code=code, body="", stderr=SECRET)
                self.assertEqual((result.returncode, calls), (code, 1))
                self.assertIn("HTTP_STATUS=000", result.stdout)
                self.assertIn("CURL_EXIT=" + str(code), result.stdout)

    def test_malformed_or_wrong_shape_json_does_not_continue(self):
        for body in ("<html>not JSON</html>", "[]", "null", "true", '{"status":"OK","generationStatus":"IN_PROGRESS","remainingEligibleCount":true}'):
            with self.subTest(body=body):
                result, calls = self.run_workflow(body=body)
                self.assertEqual((result.returncode, calls), (0, 1))
                self.assertNotIn("Traceback", result.stderr)

    def test_403_redacts_credentials_and_workflow_commands(self):
        body = '\n'.join((
            '<html>403 Forbidden</html>',
            '"Authorization": "Basic dGVzdA=="',
            'Bearer short',
            'CLIENT_SECRET="a value with spaces"',
            SECRET, PASSWORD, 'a' * 40,
            'postgres://user:pass@localhost/database',
            '::error::injected',
        ))
        result, calls = self.run_workflow(status="403", exit_code=22, body=body)
        self.assertEqual((result.returncode, calls), (22, 1))
        self.assertIn('403 Forbidden', result.stdout)
        for value in ('dGVzdA==', 'Bearer short', 'a value with spaces', 'a' * 40, 'user:pass', '::error::'):
            self.assertNotIn(value, result.stdout)
        self.assertIn('[REDACTED]', result.stdout)

    def test_cap_drops_partial_secret_and_bounds_utf8_output(self):
        for body in ('x' * 4085 + SECRET, '\n'.join('€' * 10 for _ in range(200))):
            result, _ = self.run_workflow(status="403", exit_code=22, body=body)
            output = result.stdout.split('RESPONSE_BODY_BEGIN\n')[1].split('\nRESPONSE_BODY_END')[0]
            self.assertIn('[RESPONSE_BODY_TRUNCATED]', output)
            excerpt = output.split('\n[RESPONSE_BODY_TRUNCATED]')[0]
            self.assertLessEqual(len(excerpt.encode()), 4096)
            self.assertNotIn('test-cron', output)

    def test_fundamentals_connection_timeout_and_no_retry(self):
        for code in (0, 22, 28):
            with self.subTest(code=code):
                result, calls = self.run_workflow(exit_code=code, workflow="alpha-vantage-cron.yml")
                self.assertEqual((result.returncode, calls), (code, 1))


if __name__ == "__main__":
    unittest.main()
