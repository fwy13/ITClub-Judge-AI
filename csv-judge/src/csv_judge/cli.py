"""Command-line interface for the CSV judge."""

import argparse
import json
from collections.abc import Sequence

from csv_judge.adapters import TASK_ADAPTERS
from csv_judge.judge import judge_submission, validate_problem
from csv_judge.metric_registry import METRICS


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="csv-judge")
    subparsers = parser.add_subparsers(dest="command", required=True)

    score = subparsers.add_parser("score", help="Score one CSV submission")
    score.add_argument("--problem", required=True, help="Problem directory")
    score.add_argument("--submission", required=True, help="Submission CSV path")
    score.add_argument(
        "--output",
        choices=["text", "json"],
        default="text",
        help="Output format",
    )
    validate = subparsers.add_parser(
        "validate-problem",
        help="Validate config, ground truth, and sample submission",
    )
    validate.add_argument("problem", help="Problem directory")
    validate.add_argument(
        "--output",
        choices=["text", "json"],
        default="text",
        help="Output format",
    )
    capabilities = subparsers.add_parser(
        "list-capabilities",
        help="List registered task types and compatible metrics",
    )
    capabilities.add_argument(
        "--output",
        choices=["text", "json"],
        default="text",
        help="Output format",
    )
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    if args.command == "list-capabilities":
        task_metrics = {
            task: sorted(
                metric.name
                for metric in METRICS.values()
                if task in metric.tasks
            )
            for task in sorted(TASK_ADAPTERS)
        }
        if args.output == "json":
            print(json.dumps(task_metrics, ensure_ascii=False))
        else:
            for task, metrics in task_metrics.items():
                print(f"{task}: {', '.join(metrics)}")
        return 0

    if args.command == "validate-problem":
        result = validate_problem(args.problem)
    else:
        result = judge_submission(args.problem, args.submission)

    if args.output == "json":
        print(json.dumps(result.to_dict(), ensure_ascii=False))
    elif result.status == "accepted":
        print("ACCEPTED")
        print(f"Metric: {result.metric}")
        print(f"Score: {result.score:.6f}")
        print(f"Rows: {result.rows}")
    else:
        print(result.status.upper())
        print(f"Error: {result.error_code}")
        print(f"Message: {result.message}")
        if result.examples:
            print(f"Examples: {', '.join(result.examples)}")

    return 0 if result.status == "accepted" else 1


if __name__ == "__main__":
    raise SystemExit(main())
