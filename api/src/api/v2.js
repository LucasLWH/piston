const express = require('express');
const router = express.Router();

const events = require('events');

const config = require('../config');
const runtime = require('../runtime');
const { Job } = require('../job');
const package = require('../package');
const logger = require('logplease').create('api/v2');

const SIGNALS = ["SIGABRT","SIGALRM","SIGBUS","SIGCHLD","SIGCLD","SIGCONT","SIGEMT","SIGFPE","SIGHUP","SIGILL","SIGINFO","SIGINT","SIGIO","SIGIOT","SIGKILL","SIGLOST","SIGPIPE","SIGPOLL","SIGPROF","SIGPWR","SIGQUIT","SIGSEGV","SIGSTKFLT","SIGSTOP","SIGTSTP","SIGSYS","SIGTERM","SIGTRAP","SIGTTIN","SIGTTOU","SIGUNUSED","SIGURG","SIGUSR1","SIGUSR2","SIGVTALRM","SIGXCPU","SIGXFSZ","SIGWINCH"]
// ref: https://man7.org/linux/man-pages/man7/signal.7.html

function get_job(body){
    const {
        language,
        version,
        args,
        stdin,
        files,
        compile_memory_limit,
        run_memory_limit,
        run_timeout,
        compile_timeout
    } = body;

    return new Promise((resolve, reject) => {
        if (!language || typeof language !== 'string') {
            return reject({
                message: 'language is required as a string',
            });
        }

        if (!version || typeof version !== 'string') {
            return reject({
                message: 'version is required as a string',
            });
        }

        if (!files || !Array.isArray(files)) {
            return reject({
                message: 'files is required as an array',
            });
        }

        for (const [i, file] of files.entries()) {
            if (typeof file.content !== 'string') {
                return reject({
                    message: `files[${i}].content is required as a string`,
                });
            }
        }

        if (compile_memory_limit) {
            if (typeof compile_memory_limit !== 'number') {
                return reject({
                    message: 'if specified, compile_memory_limit must be a number',
                });
            }

            if (
                config.compile_memory_limit >= 0 &&
                (compile_memory_limit > config.compile_memory_limit ||
                    compile_memory_limit < 0)
            ) {
                return reject({
                    message:
                        'compile_memory_limit cannot exceed the configured limit of ' +
                        config.compile_memory_limit,
                });
            }
        }

        if (run_memory_limit) {
            if (typeof run_memory_limit !== 'number') {
                return reject({
                    message: 'if specified, run_memory_limit must be a number',
                });
            }

            if (
                config.run_memory_limit >= 0 &&
                (run_memory_limit > config.run_memory_limit || run_memory_limit < 0)
            ) {
                return reject({
                    message:
                        'run_memory_limit cannot exceed the configured limit of ' +
                        config.run_memory_limit,
                });
            }
        }

        const rt = runtime.get_latest_runtime_matching_language_version(
            language,
            version
        );

        if (rt === undefined) {
            return reject({
                message: `${language}-${version} runtime is unknown`,
            });
        }

        resolve(new Job({
            runtime: rt,
            alias: language,
            args: args || [],
            stdin: stdin || "",
            files,
            timeouts: {
                run: run_timeout || 3000,
                compile: compile_timeout || 10000,
            },
            memory_limits: {
                run: run_memory_limit || config.run_memory_limit,
                compile: compile_memory_limit || config.compile_memory_limit,
            }
        }));
    })

}

router.use((req, res, next) => {
    if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
        return next();
    }

    if (!req.headers['content-type'].startsWith('application/json')) {
        return res.status(415).send({
            message: 'requests must be of type application/json',
        });
    }

    next();
});

router.ws('/connect', async (ws, req) => {

    let job = null;
    let eventBus = new events.EventEmitter();

    eventBus.on("stdout", (data) => ws.send(JSON.stringify({type: "data", stream: "stdout", data: data.toString()})))
    eventBus.on("stderr", (data) => ws.send(JSON.stringify({type: "data", stream: "stderr", data: data.toString()})))
    eventBus.on("stage", (stage)=> ws.send(JSON.stringify({type: "stage", stage})))
    eventBus.on("exit", (stage, status) => ws.send(JSON.stringify({type: "exit", stage, ...status})))

    ws.on("message", async (data) => {
        
        try{
            const msg = JSON.parse(data);

            switch(msg.type){
                case "init":
                    if(job === null){
                        job = await get_job(msg);

                        await job.prime();

                        ws.send(JSON.stringify({
                            type: "runtime",
                            language: job.runtime.language,
                            version: job.runtime.version.raw
                        }))

                        await job.execute_interactive(eventBus);

                        ws.close(4999, "Job Completed");

                    }else{
                        ws.close(4000, "Already Initialized");
                    }
                    break;
            case "data":
                if(job !== null){
                    if(msg.stream === "stdin"){
                        eventBus.emit("stdin", msg.data)
                    }else{
                        ws.close(4004, "Can only write to stdin")
                    }
                }else{
                    ws.close(4003, "Not yet initialized")
                }
                break;
            case "signal":
                if(job !== null){
                    if(SIGNALS.includes(msg.signal)){
                        eventBus.emit("signal", msg.signal)
                    }else{
                        ws.close(4005, "Invalid signal")
                    }
                }else{
                    ws.close(4003, "Not yet initialized")
                }
                break;
            }
            
        }catch(error){
            ws.send(JSON.stringify({type: "error", message: error.message}))
            ws.close(4002, "Notified Error")
            // ws.close message is limited to 123 characters, so we notify over WS then close.
        }
    })

    ws.on("close", async ()=>{
        if(job !== null){
            await job.cleanup()
        }
    })

    setTimeout(()=>{
        //Terminate the socket after 1 second, if not initialized.
        if(job === null)
            ws.close(4001, "Initialization Timeout");
    }, 1000)
})

router.post('/execute', async (req, res) => {

    try{
        const job = await get_job(req.body);

        await job.prime();

        const result = await job.execute();

        await job.cleanup();

        return res.status(200).send(result);
    }catch(error){
        return res.status(400).json(error);
    }
});

router.get('/runtimes', (req, res) => {
    const runtimes = runtime.map(rt => {
        return {
            language: rt.language,
            version: rt.version.raw,
            aliases: rt.aliases,
            runtime: rt.runtime,
        };
    });

    return res.status(200).send(runtimes);
});

router.get('/packages', async (req, res) => {
    logger.debug('Request to list packages');
    let packages = await package.get_package_list();

    packages = packages.map(pkg => {
        return {
            language: pkg.language,
            language_version: pkg.version.raw,
            installed: pkg.installed,
        };
    });

    return res.status(200).send(packages);
});

router.post('/packages', async (req, res) => {
    logger.debug('Request to install package');

    const { language, version } = req.body;

    const pkg = await package.get_package(language, version);

    if (pkg == null) {
        return res.status(404).send({
            message: `Requested package ${language}-${version} does not exist`,
        });
    }

    try {
        const response = await pkg.install();

        return res.status(200).send(response);
    } catch (e) {
        logger.error(
            `Error while installing package ${pkg.language}-${pkg.version}:`,
            e.message
        );

        return res.status(500).send({
            message: e.message,
        });
    }
});

router.delete('/packages', async (req, res) => {
    logger.debug('Request to uninstall package');

    const { language, version } = req.body;

    const pkg = await package.get_package(language, version);

    if (pkg == null) {
        return res.status(404).send({
            message: `Requested package ${language}-${version} does not exist`,
        });
    }

    try {
        const response = await pkg.uninstall();

        return res.status(200).send(response);
    } catch (e) {
        logger.error(
            `Error while uninstalling package ${pkg.language}-${pkg.version}:`,
            e.message
        );

        return res.status(500).send({
            message: e.message,
        });
    }
});

module.exports = router;
