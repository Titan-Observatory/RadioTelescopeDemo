"""Pi-side fan-out of raw IQ samples to WebSocket subscribers.

In `gateway-server` mode the Pi does not compute spectra — it just forwards
raw `uint8` I/Q pairs over `/ws/iq` so the LAN host can run the FFT
pipeline. This service drives `SDRReceiver.stream_bytes()` (which gets the
data straight out of pyrtlsdr without a numpy round-trip) and fans the
chunks out to subscribers using drop-oldest on full queues.

The default subscriber queue is sized to absorb one USB transfer's worth of
chunks (pyrtlsdr typically delivers ~8 FFT-sized chunks per USB transfer at
2.4 Msps with `fft_size = 2048`) so transient backpressure doesn't silently
eat samples.
"""
from __future__ import annotations

import logging

from radiotelescope.hardware.sdr import SDRReceiver
from radiotelescope.services._sdr_task import SDRDriverTask

logger = logging.getLogger(__name__)


class IQPublisher(SDRDriverTask[bytes]):
    name = "iq-publisher"
    default_maxsize = 32

    def __init__(self, receiver: SDRReceiver) -> None:
        super().__init__(receiver)

    async def _run(self) -> None:
        async for payload in self._rx.stream_bytes():
            if self.subscriber_count == 0:
                continue
            self.publish(payload)


__all__ = ("IQPublisher",)
