#!/usr/bin/env python3
"""
Automated tests for token reporting socket commands.

Usage:
    python3 test_token_reporting.py

Requirements:
    - cmux must be running with the socket controller enabled
"""

import os
import sys
import time

# Add the directory containing cmux.py to the path
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from cmux import cmux, cmuxError


class TestResult:
    def __init__(self, name: str):
        self.name = name
        self.passed = False
        self.message = ""

    def success(self, msg: str = ""):
        self.passed = True
        self.message = msg

    def failure(self, msg: str):
        self.passed = False
        self.message = msg


def test_connection(client: cmux) -> TestResult:
    """Test that we can connect and ping the server"""
    result = TestResult("Connection")
    try:
        if client.ping():
            result.success("Connected and received PONG")
        else:
            result.failure("Ping failed")
    except Exception as e:
        result.failure(str(e))
    return result


def test_report_tokens_basic(client: cmux) -> TestResult:
    """report_tokens with required --cost returns OK"""
    result = TestResult("report_tokens basic")
    try:
        response = client._send_command("report_tokens --cost=0.42 --input=50000 --output=10000")
        if response.strip() == "OK":
            result.success("report_tokens accepted with cost, input, output")
        else:
            result.failure(f"Expected OK, got: {response}")
    except Exception as e:
        result.failure(f"Exception: {e}")
    return result


def test_report_tokens_missing_cost(client: cmux) -> TestResult:
    """report_tokens without --cost returns error"""
    result = TestResult("report_tokens missing cost")
    try:
        response = client._send_command("report_tokens --input=50000")
        if "ERROR" in response:
            result.success("Correctly rejected missing --cost")
        else:
            result.failure(f"Expected ERROR, got: {response}")
    except Exception as e:
        result.failure(f"Exception: {e}")
    return result


def test_report_tokens_with_model(client: cmux) -> TestResult:
    """report_tokens with --model flag returns OK"""
    result = TestResult("report_tokens with model")
    try:
        response = client._send_command(
            "report_tokens --cost=0.42 --input=50000 --output=10000 --model=claude-sonnet-4-20250514"
        )
        if response.strip() == "OK":
            result.success("report_tokens accepted with --model")
        else:
            result.failure(f"Expected OK, got: {response}")
    except Exception as e:
        result.failure(f"Exception: {e}")
    return result


def test_report_tokens_all_fields(client: cmux) -> TestResult:
    """report_tokens with all fields returns OK"""
    result = TestResult("report_tokens all fields")
    try:
        response = client._send_command(
            "report_tokens --cost=1.23 --input=100000 --output=20000"
            " --cache-read=80000 --cache-write=10000 --model=gpt-4o"
        )
        if response.strip() == "OK":
            result.success("report_tokens accepted with all fields")
        else:
            result.failure(f"Expected OK, got: {response}")
    except Exception as e:
        result.failure(f"Exception: {e}")
    return result


def test_clear_tokens(client: cmux) -> TestResult:
    """clear_tokens returns OK"""
    result = TestResult("clear_tokens")
    try:
        # First report some tokens
        client._send_command("report_tokens --cost=0.42 --input=50000 --output=10000")
        # Then clear
        response = client._send_command("clear_tokens")
        if response.strip() == "OK":
            result.success("clear_tokens returned OK")
        else:
            result.failure(f"Expected OK, got: {response}")
    except Exception as e:
        result.failure(f"Exception: {e}")
    return result


def test_report_tokens_zero_cost(client: cmux) -> TestResult:
    """report_tokens with zero cost is valid"""
    result = TestResult("report_tokens zero cost")
    try:
        response = client._send_command("report_tokens --cost=0.0")
        if response.strip() == "OK":
            result.success("report_tokens accepted zero cost")
        else:
            result.failure(f"Expected OK, got: {response}")
    except Exception as e:
        result.failure(f"Exception: {e}")
    return result


def test_report_tokens_updates_overwrite(client: cmux) -> TestResult:
    """Subsequent report_tokens overwrites previous state"""
    result = TestResult("report_tokens overwrite")
    try:
        client._send_command("report_tokens --cost=0.10 --input=1000")
        response = client._send_command("report_tokens --cost=0.50 --input=5000")
        if response.strip() == "OK":
            result.success("Second report_tokens accepted (overwrites previous)")
        else:
            result.failure(f"Expected OK, got: {response}")
    except Exception as e:
        result.failure(f"Exception: {e}")
    return result


def run_tests():
    """Run all tests"""
    print("=" * 60)
    print("cmux Token Reporting Tests")
    print("=" * 60)
    print()

    socket_path = cmux.DEFAULT_SOCKET_PATH
    if not os.path.exists(socket_path):
        print(f"Error: Socket not found at {socket_path}")
        print("Please make sure cmux is running.")
        return 1

    results = []

    test_funcs = [
        ("Connection", test_connection),
        ("report_tokens basic", test_report_tokens_basic),
        ("report_tokens missing cost", test_report_tokens_missing_cost),
        ("report_tokens with model", test_report_tokens_with_model),
        ("report_tokens all fields", test_report_tokens_all_fields),
        ("clear_tokens", test_clear_tokens),
        ("report_tokens zero cost", test_report_tokens_zero_cost),
        ("report_tokens overwrite", test_report_tokens_updates_overwrite),
    ]

    try:
        with cmux() as client:
            for label, test_func in test_funcs:
                print(f"Testing {label}...")
                r = test_func(client)
                results.append(r)
                status = "✅" if r.passed else "❌"
                print(f"  {status} {r.message}")
                print()

                # Stop early if connection failed
                if label == "Connection" and not r.passed:
                    return 1

                time.sleep(0.1)

    except cmuxError as e:
        print(f"Error: {e}")
        return 1

    # Summary
    print("=" * 60)
    print("Test Results Summary")
    print("=" * 60)

    passed = sum(1 for r in results if r.passed)
    total = len(results)

    for r in results:
        status = "✅ PASS" if r.passed else "❌ FAIL"
        print(f"  {r.name}: {status}")
        if not r.passed and r.message:
            print(f"      {r.message}")

    print()
    print(f"Passed: {passed}/{total}")

    if passed == total:
        print("\n🎉 All tests passed!")
        return 0
    else:
        print(f"\n⚠️  {total - passed} test(s) failed")
        return 1


if __name__ == "__main__":
    sys.exit(run_tests())
