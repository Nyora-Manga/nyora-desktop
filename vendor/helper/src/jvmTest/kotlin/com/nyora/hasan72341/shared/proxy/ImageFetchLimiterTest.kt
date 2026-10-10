package com.nyora.hasan72341.shared.proxy

import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import kotlin.test.Test
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertFalse
import kotlin.test.assertTrue

class ImageFetchLimiterTest {

    @Test
    fun rejectsExcessFetchWhileAllImageSlotsAreHeld() {
        val limiter = ImageFetchLimiter(maxInFlight = 2, waitMillis = 0)
        val acquired = CountDownLatch(2)
        val release = CountDownLatch(1)
        val pool = Executors.newFixedThreadPool(2)
        try {
            val workers = List(2) {
                pool.submit {
                    val lease = assertNotNull(limiter.tryAcquire())
                    lease.use {
                        acquired.countDown()
                        assertTrue(release.await(5, TimeUnit.SECONDS))
                    }
                }
            }
            assertTrue(acquired.await(5, TimeUnit.SECONDS))

            assertNull(limiter.tryAcquire())

            release.countDown()
            workers.forEach { it.get(5, TimeUnit.SECONDS) }
            assertNotNull(limiter.tryAcquire()).close()
        } finally {
            release.countDown()
            pool.shutdownNow()
        }
    }

    @Test
    fun ordinaryBurstWaitsForAReleasedSlotInsteadOfReturningABlankImage() {
        val limiter = ImageFetchLimiter(maxInFlight = 3, waitMillis = 5_000)
        val leases = List(3) { assertNotNull(limiter.tryAcquire()) }
        val pool = Executors.newSingleThreadExecutor()
        val fourthStarted = CountDownLatch(1)
        try {
            val fourth = pool.submit<AutoCloseable?> {
                fourthStarted.countDown()
                limiter.tryAcquire()
            }

            assertTrue(fourthStarted.await(2, TimeUnit.SECONDS))
            assertFalse(fourth.isDone, "the fourth image should queue while the first three load")

            leases.first().close()
            assertNotNull(fourth.get(2, TimeUnit.SECONDS)).close()
        } finally {
            leases.drop(1).forEach(AutoCloseable::close)
            pool.shutdownNow()
        }
    }
}
