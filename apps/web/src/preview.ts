/**
 * Worker-preview bootstrap: the one module preview.html adds ahead of the
 * stock entry tag. Connecting the worker host installs the boot globals and
 * settles `__DSH_BOOT_READY__`, where the stock entry's pre-boot await holds,
 * so everything after this module is the served startup chain verbatim. A
 * failed handshake rejects the deferred into the boot page's failure
 * rendering; this module owns no page painting.
 */
import DshWorker from '@deepseek-ai/dsh-experimental-webworker-runtime/worker?worker'
import { connectWorkerHost, IMAGE_FILE_NAME } from '@deepseek-ai/dsh-experimental-webworker-runtime/client'

await connectWorkerHost(new DshWorker({ name: 'dsh-host' }), { image: `preview/${IMAGE_FILE_NAME}` })
