# dotenvrtdb

A simple dotenv CLI for loading environment variables from `.env` files **with remote realtime database support**.

## Installing

NPM

```bash
$ npm install -g @tolaptrinhdh61-spec/dotenvrtdb
```

Yarn

```bash
$ yarn global add @tolaptrinhdh61-spec/dotenvrtdb
```

pnpm

```bash
$ pnpm add -g @tolaptrinhdh61-spec/dotenvrtdb
```

## Usage

### Basic Usage

```bash
$ dotenvrtdb -- <command with arguments>
```

This will load the variables from the .env file in the current working directory and then run the command (using the new set of environment variables).

Alternatively, if you do not need to pass arguments to the command, you can use the shorthand:

```bash
$ dotenvrtdb <command>
```

### 🔥 NEW: Remote Database Sync

#### Pull environment variables from remote database

Download environment variables from a realtime database (Firebase, custom API, etc.) and save to a local `.env` file:

```bash
$ dotenvrtdb --pull https://your-project.firebaseio.com/env.json
```

Specify custom output file:

```bash
$ dotenvrtdb --pull https://your-project.firebaseio.com/env.json --pull-output .env.production
```

#### Push environment variables to remote database

Upload your local `.env` file to a realtime database:

```bash
$ dotenvrtdb --push https://your-project.firebaseio.com/env.json
```

Specify custom source file:

```bash
$ dotenvrtdb --push https://your-project.firebaseio.com/env.json --push-source .env.staging
```

**Example workflow:**

```bash
# Pull production env from Firebase
$ dotenvrtdb --pull https://myapp.firebaseio.com/env/prod.json --pull-output .env.production

# Run your app with production env
$ dotenvrtdb -e .env.production -- node app.js

# Update local env and push back
$ dotenvrtdb --push https://myapp.firebaseio.com/env/prod.json --push-source .env.production
```

### Custom .env files

Another .env file could be specified using the -e flag (this will replace loading `.env` file):

```bash
$ dotenvrtdb -e .env2 -- <command with arguments>
```

Multiple .env files can be specified, and will be processed in order, but only sets variables if they haven't already been set. So the first one wins (existing env variables win over the first file and the first file wins over the second file):

```bash
$ dotenvrtdb -e .env3 -e .env4 -- <command with arguments>
```

### Cascading env variables

Some applications load env variables from multiple `.env` files depending on the environment:

- `.env`
- `.env.local`
- `.env.development`
- `.env.development.local`

dotenvrtdb supports this using the `-c` flag:

- `-c` loads `.env` and `.env.local`
- `-c test` loads `.env`, `.env.local`, `.env.test`, and `.env.test.local`

See [#37](https://github.com/entropitor/dotenvrtdb/issues/37) for more information.

The `-c` flag can be used together with the `-e` flag. The following example will cascade env files located one folder up in the directory tree (`../.env` followed by `../.env.local`):

```bash
dotenvrtdb -e ../.env -c
```

### Setting variable from command line

It is possible to set variable directly from command line using the -v flag:

```bash
$ dotenvrtdb -v VARIABLE=somevalue -- <command with arguments>
```

Multiple variables can be specified:

```bash
$ dotenvrtdb -v VARIABLE1=somevalue1 -v VARIABLE2=somevalue2 -- <command with arguments>
```

Variables set up from command line have higher priority than from env files.

> Purpose of this is that standard approach `VARIABLE=somevalue <command with arguments>` doesn't work on Windows. The -v flag works on all the platforms.

### Check env variable

If you want to check the value of an environment variable, use the `-p` flag

```bash
$ dotenvrtdb -p NODE_ENV
```

### Flags to the underlying command

If you want to pass flags to the inner command use `--` after all the flags to `dotenvrtdb`.

E.g. the following command without dotenvrtdb:

```bash
mvn exec:java -Dexec.args="-g -f"
```

will become the following command with dotenvrtdb:

```bash
$ dotenvrtdb -- mvn exec:java -Dexec.args="-g -f"
```

or in case the env file is at `.my-env`

```bash
$ dotenvrtdb -e .my-env -- mvn exec:java -Dexec.args="-g -f"
```

### Variable expansion

We support expanding env variables inside .env files (See [dotenv-expand](https://github.com/motdotla/dotenv-expand) npm package for more information)

For example:

```
IP=127.0.0.1
PORT=1234
APP_URL=http://${IP}:${PORT}
```

Using the above example `.env` file, `process.env.APP_URL` would be `http://127.0.0.1:1234`.

#### Disabling variable expansion

If your `.env` variables include values that should not be expanded (e.g. `PASSWORD="pas$word"`), you can pass flag `--no-expand` to `dotenvrtdb` to disable variable expansion.

For example:

```bash
dotenvrtdb --no-expand <command>
```

### Variable expansion in the command

If your `.env` file looks like:

```
SAY_HI=hello!
```

you might expect `dotenv echo "$SAY_HI"` to display `hello!`. In fact, this is not what happens: your shell will first interpret your command before passing it to `dotenvrtdb`, so if `SAY_HI` envvar is set to `""`, the command will be expanded into `dotenv echo`: that's why `dotenvrtdb` cannot make the expansion you expect.

#### Possible solutions

1. Bash and escape

One possible way to get the desired result is:

```
$ dotenv -- bash -c 'echo "$SAY_HI"'
```

In bash, everything between `'` is not interpreted but passed as is. Since `$SAY_HI` is inside `''` brackets, it's passed as a string literal.

Therefore, `dotenvrtdb` will start a child process `bash -c 'echo "$SAY_HI"'` with the env variable `SAY_HI` set correctly which means bash will run `echo "$SAY_HI"` in the right environment which will print correctly `hello`

2. Subscript encapsulation

Another solution is simply to encapsulate your script in another subscript.

Example here with npm scripts in a package.json

```json
{
  "scripts": {
    "_print-stuff": "echo $STUFF",
    "print-stuff": "dotenv -- npm run _print-stuff"
  }
}
```

This example is used in a project setting (has a package.json). Should always install locally `npm install -D dotenvrtdb`

### Debugging

You can add the `--debug` flag to output the `.env` files that would be processed and exit.

### Override

Override any environment variables that have already been set on your machine with values from your .env file.

```bash
dotenvrtdb -e .env.test -o -- jest
```

## Command Reference

```
Usage: dotenvrtdb [--help] [--debug] [--quiet=false] [-e <path>] [-v <name>=<value>]
              [-p <variable name>] [-c [environment]] [--no-expand] [-- command]

Options:
  --help              print help
  --debug             output the files that would be processed but don't actually parse them
  --quiet, -q         suppress debug output from dotenvrtdb (default: true)
  -e <path>           parses the file <path> as a `.env` file
  -e <path>           multiple -e flags are allowed
  -v <name>=<value>   put variable <name> into environment using value <value>
  -v <name>=<value>   multiple -v flags are allowed
  -p <variable>       print value of <variable> to the console
  -c [environment]    support cascading env variables from multiple files
  --no-expand         skip variable expansion
  -o, --override      override system variables. Cannot be used with cascade (-c)
  command             command to run with environment variables loaded

Remote database commands:
  --pull <url>              pull env variables from remote database URL and save to .env
  --pull-output <path>      specify output file for pull command (default: .env)
  --push <url>              push local .env file to remote database URL
  --push-source <path>      specify source file for push command (default: .env)
```

## Use Cases

### Team Environment Sync

Keep your team's environment variables in sync using Firebase Realtime Database:

```bash
# Team lead pushes the base config
$ dotenvrtdb --push https://team-project.firebaseio.com/env/base.json

# Team members pull the config
$ dotenvrtdb --pull https://team-project.firebaseio.com/env/base.json
```

### Multi-Environment Deployment

Manage different environments easily:

```bash
# Pull production config
$ dotenvrtdb --pull https://myapp.firebaseio.com/prod.json --pull-output .env.production

# Pull staging config
$ dotenvrtdb --pull https://myapp.firebaseio.com/staging.json --pull-output .env.staging

# Run with specific environment
$ dotenvrtdb -e .env.production -- node server.js
```

### CI/CD Integration

Store secrets in Firebase and pull them during deployment:

```yaml
# .github/workflows/deploy.yml
- name: Pull environment variables
  run: dotenv --pull ${{ secrets.FIREBASE_ENV_URL }} --pull-output .env.production

- name: Deploy application
  run: dotenv -e .env.production -- npm run deploy
```

## Remote Database Format

The remote database should return JSON in the following format:

```json
{
  "DATABASE_URL": "postgresql://localhost:5432/mydb",
  "API_KEY": "your-api-key-here",
  "NODE_ENV": "production",
  "PORT": "3000"
}
```

This will be converted to `.env` format:

```
DATABASE_URL=postgresql://localhost:5432/mydb
API_KEY=your-api-key-here
NODE_ENV=production
PORT=3000
```

## Security Considerations

⚠️ **Important Security Notes:**

- Never commit `.env` files containing sensitive data to version control
- Use Firebase Security Rules to restrict access to your env database
- For production secrets, consider using environment-specific databases with proper authentication
- The `--pull` command requires read access to the database URL
- The `--push` command requires write access to the database URL

Example Firebase Security Rules:

```json
{
  "rules": {
    "env": {
      ".read": "auth != null",
      ".write": "auth != null && auth.token.admin === true"
    }
  }
}
```

## License

[MIT](https://en.wikipedia.org/wiki/MIT_License)

## Credits

Based on [dotenvrtdb](https://github.com/entropitor/dotenvrtdb) with added remote database synchronization features.
