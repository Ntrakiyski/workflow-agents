class ServiceError(Exception):
    def __init__(self, status, code, message, retryable=False):
        self.status, self.code, self.message, self.retryable = status, code, message, retryable
        super().__init__(code)


def unavailable(code='runtime_unavailable'):
    return ServiceError(503, code, 'Required execution dependency is unavailable.', True)
