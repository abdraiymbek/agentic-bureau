//! Fan-out of host events to server-sent-event subscribers.
//!
//! Emitters never wait for a reader: each subscriber has a bounded queue and
//! is dropped when it falls behind. A dropped or disconnected reader resumes
//! with `Last-Event-ID`; when what it missed is no longer held, the stream
//! opens with a `resync` event so the reader knows to fetch state again
//! instead of trusting a stream with a hole in it.

use omenflow_agent_host::{EventSink, HostEvent};
use serde_json::Value;
use std::collections::VecDeque;
use std::sync::mpsc::{sync_channel, Receiver, SyncSender, TrySendError};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};

const BACKLOG_FRAMES: usize = 2048;
const BACKLOG_BYTES: usize = 8 * 1024 * 1024;
const SUBSCRIBER_QUEUE: usize = 4096;

pub(crate) const RESYNC_FRAME: &str = "event: resync\ndata: {}\n\n";

pub(crate) struct EventHub {
    /// Distinguishes this process's stream from an earlier run's, so an id
    /// kept by a reconnecting reader is never matched against the wrong one.
    stream: String,
    inner: Mutex<Inner>,
}

struct Inner {
    next: u64,
    backlog: VecDeque<(u64, Arc<str>)>,
    backlog_bytes: usize,
    subscribers: Vec<SyncSender<Arc<str>>>,
    closed: bool,
}

pub(crate) struct Subscription {
    /// Frames the reader missed, oldest first, or a single `resync` frame.
    pub replay: Vec<Arc<str>>,
    pub live: Receiver<Arc<str>>,
}

impl EventHub {
    pub fn new() -> Self {
        Self {
            stream: uuid::Uuid::new_v4().simple().to_string()[..8].to_owned(),
            inner: Mutex::new(Inner {
                next: 1,
                backlog: VecDeque::new(),
                backlog_bytes: 0,
                subscribers: Vec::new(),
                closed: false,
            }),
        }
    }

    fn inner(&self) -> MutexGuard<'_, Inner> {
        self.inner.lock().unwrap_or_else(PoisonError::into_inner)
    }

    pub fn publish(&self, name: &str, payload: &Value) {
        let mut inner = self.inner();
        if inner.closed {
            return;
        }
        let id = inner.next;
        inner.next += 1;
        let frame: Arc<str> = format!(
            "id: {}-{id}\nevent: {name}\ndata: {payload}\n\n",
            self.stream
        )
        .into();
        inner.backlog_bytes += frame.len();
        inner.backlog.push_back((id, Arc::clone(&frame)));
        while inner.backlog.len() > BACKLOG_FRAMES || inner.backlog_bytes > BACKLOG_BYTES {
            match inner.backlog.pop_front() {
                Some((_, dropped)) => inner.backlog_bytes -= dropped.len(),
                None => break,
            }
        }
        inner
            .subscribers
            .retain(|subscriber| match subscriber.try_send(Arc::clone(&frame)) {
                Ok(()) => true,
                Err(TrySendError::Full(_) | TrySendError::Disconnected(_)) => false,
            });
    }

    /// Start reading. `last_event_id` is what the reader last saw, if it is
    /// resuming.
    pub fn subscribe(&self, last_event_id: Option<&str>) -> Subscription {
        let mut inner = self.inner();
        let (sender, live) = sync_channel(SUBSCRIBER_QUEUE);
        let replay = match last_event_id {
            None => Vec::new(),
            Some(last) => match self.position(last) {
                Some(seen) if seen < inner.next && inner.holds_everything_after(seen) => inner
                    .backlog
                    .iter()
                    .filter(|(id, _)| *id > seen)
                    .map(|(_, frame)| Arc::clone(frame))
                    .collect(),
                _ => vec![RESYNC_FRAME.into()],
            },
        };
        if !inner.closed {
            inner.subscribers.push(sender);
        }
        Subscription { replay, live }
    }

    fn position(&self, last_event_id: &str) -> Option<u64> {
        let (stream, id) = last_event_id.split_once('-')?;
        (stream == self.stream).then(|| id.parse().ok()).flatten()
    }

    /// End every stream. Readers see their connection close.
    pub fn close(&self) {
        let mut inner = self.inner();
        inner.closed = true;
        inner.subscribers.clear();
    }
}

impl Inner {
    fn holds_everything_after(&self, seen: u64) -> bool {
        match self.backlog.front() {
            Some((oldest, _)) => *oldest <= seen + 1,
            None => seen + 1 == self.next,
        }
    }
}

impl EventSink for EventHub {
    fn emit(&self, event: HostEvent) {
        self.publish(event.name(), event.payload());
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn id_of(frame: &str) -> String {
        frame
            .lines()
            .next()
            .and_then(|line| line.strip_prefix("id: "))
            .expect("frame starts with its id")
            .to_owned()
    }

    #[test]
    fn frames_carry_an_id_the_event_name_and_one_data_line() {
        let hub = EventHub::new();
        let subscription = hub.subscribe(None);
        hub.emit(HostEvent::TerminalData(
            json!({ "chunk": "line one\nline two" }),
        ));
        let frame = subscription.live.try_recv().unwrap();
        let lines = frame.split('\n').collect::<Vec<_>>();
        assert!(lines[0].starts_with("id: ") && lines[0].ends_with("-1"));
        assert_eq!(
            lines[1..],
            [
                "event: terminal-data",
                r#"data: {"chunk":"line one\nline two"}"#,
                "",
                ""
            ],
            "three fields, then the blank line that ends the event"
        );
    }

    #[test]
    fn a_resuming_reader_gets_exactly_what_it_missed() {
        let hub = EventHub::new();
        let first = hub.subscribe(None);
        for seq in 1..=3 {
            hub.publish("event", &json!({ "seq": seq }));
        }
        let seen = id_of(&first.live.try_recv().unwrap());
        drop(first);
        let resumed = hub.subscribe(Some(&seen));
        assert_eq!(
            resumed
                .replay
                .iter()
                .map(|frame| frame.lines().nth(2).unwrap().to_owned())
                .collect::<Vec<_>>(),
            [r#"data: {"seq":2}"#, r#"data: {"seq":3}"#]
        );
        hub.publish("event", &json!({ "seq": 4 }));
        assert!(resumed.live.try_recv().unwrap().contains(r#"{"seq":4}"#));
        let up_to_date = hub.subscribe(Some(&id_of(&resumed.replay[1])));
        assert_eq!(up_to_date.replay.len(), 1, "only seq 4 is newer");
    }

    #[test]
    fn a_reader_that_cannot_be_caught_up_is_told_to_resync() {
        let hub = EventHub::new();
        hub.publish("event", &json!({ "seq": 1 }));
        let other_run = hub.subscribe(Some("deadbeef-1"));
        assert_eq!(&*other_run.replay[0], RESYNC_FRAME);
        let from_the_future = hub.subscribe(Some(&format!("{}-99", hub.stream)));
        assert_eq!(&*from_the_future.replay[0], RESYNC_FRAME);
        assert_eq!(&*hub.subscribe(Some("garbage")).replay[0], RESYNC_FRAME);

        let padding = "x".repeat(64 * 1024);
        for _ in 0..(BACKLOG_BYTES / padding.len() + 8) {
            hub.publish("terminal-data", &json!({ "chunk": padding }));
        }
        let fell_behind = hub.subscribe(Some(&format!("{}-1", hub.stream)));
        assert_eq!(fell_behind.replay.len(), 1);
        assert_eq!(&*fell_behind.replay[0], RESYNC_FRAME);
        let inner = hub.inner();
        assert!(inner.backlog_bytes <= BACKLOG_BYTES);
        assert_eq!(
            inner.backlog_bytes,
            inner.backlog.iter().map(|(_, f)| f.len()).sum::<usize>()
        );
    }

    #[test]
    fn a_reader_that_stops_reading_is_dropped_without_blocking_emitters() {
        let hub = EventHub::new();
        let stalled = hub.subscribe(None);
        let healthy = hub.subscribe(None);
        for seq in 0..=SUBSCRIBER_QUEUE {
            hub.publish("event", &json!({ "seq": seq }));
            healthy.live.try_recv().unwrap();
        }
        assert_eq!(hub.inner().subscribers.len(), 1);
        assert_eq!(stalled.live.try_iter().count(), SUBSCRIBER_QUEUE);
        assert!(stalled.live.recv().is_err(), "the stalled stream ends");
    }

    #[test]
    fn closing_ends_streams_and_ignores_later_events() {
        let hub = EventHub::new();
        let reader = hub.subscribe(None);
        hub.close();
        hub.publish("event", &json!({}));
        assert!(reader.live.recv().is_err());
        assert!(hub.subscribe(None).live.recv().is_err());
    }
}
