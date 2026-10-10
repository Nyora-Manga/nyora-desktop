package com.nyora.hasan72341.shared

import com.nyora.hasan72341.shared.extension.JvmExtensionRuntime
import com.nyora.hasan72341.shared.repository.JsonLibraryRepository

object NyoraFacadeFactory {
    fun create(): NyoraFacade = NyoraFacade(
        repository = JsonLibraryRepository(),
        runtime = JvmExtensionRuntime(),
    )
}
