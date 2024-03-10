# grammY OpenTelemetry

Integrates OpenTelemetry into grammY.

Development is in progress.

## Description

After a lot of thought and research, we came to the conclusion that it would be bad to integrate with a particular
technology, especially if it is possible to support many at once. Fortunately, there is the OpenTelemetry project, which
defines a single approach to collecting and managing telemetry that integrates perfectly with many existing services.
However, there are some problems with it:

1. The JS toolkit is quite young, so many things are experimental or just under development, which makes it difficult to
   use.
2. They split the Web and Node.js tools into separate packages, which will cause support issues in the future.
3. They are very fond of autoinstrumentation, which intercepts `require/import` calls and patches the requested package,
   which we think is a very, very bad pattern that we don't want to impose on grammY users.

So we decided to implement the OpenTelemetry specification in Deno in a way that would provide the best possible
OpenTelemetry experience in grammY while avoiding the aforementioned issues.
