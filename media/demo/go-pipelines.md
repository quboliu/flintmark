---
title: Go pipelines field notes
source: https://go.dev/blog/pipelines
author: Sameer Ajmani
status: demo note
tags:
  - go
  - concurrency
  - pipelines
---

# Go pipelines: cancellation field notes

> [!tip] Adapted example
> A compact notebook inspired by the Go blog article, rewritten to show
> frontmatter, callouts, tables, code, tags, highlights, and wikilinks.

## Pipeline shape

| Stage | Job | Exit rule |
| --- | --- | --- |
| `source` | discover paths or values | close its outbound channel |
| `worker` | transform each item | stop when input closes or context cancels |
| `sink` | consume results | cancel early on error or enough data |

```go
func square(ctx context.Context, in <-chan int) <-chan int {
	out := make(chan int)
	go func() {
		defer close(out)
		for n := range in {
			select {
			case out <- n * n:
			case <-ctx.Done():
				return
			}
		}
	}()
	return out
}
```

Invariant: **senders must have a way to stop**. A downstream reader may leave
early, so upstream goroutines need a signal instead of waiting forever.

## Fan-out / fan-in checklist

- [x] close outbound channels from the sending side
- [x] use `defer` for cleanup paths
- [/] propagate cancellation through every stage
- [ ] measure the slowest stage before adding workers

> [!warning] Avoid fragile buffers
> A buffer can hide a leak in a tiny example, but it bakes in assumptions about
> item counts and reader behavior. Cancellation scales better.

Reference: [[Concurrency Notes]] #go/concurrency ==pipeline cancellation==
